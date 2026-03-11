/* eslint-disable no-console */
'use strict';

const pool = require('../config/db');
const { getBearer, fetchSalesRanged } = require('../services/maxiSalesService');
const { upsertSalesBatch, upsertDailyAggregates } = require('../services/salesStore');
const { ensureInitialBackfillOnce, runDailyAuto } = require('../services/salesSyncPolicy');

/* ───────── helpers fecha ───────── */
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const addDaysUTC = (d, n) => new Date(d.getTime() + n * 86400000);

/* ─────────────────────────────────────────────────────────────────────────
 * resolveSalesBusiness(biz)
 *
 * Los subnegocios (created_from = 'from_group') NO tienen filas propias en
 * sales_daily_items — las ventas están guardadas con el business_id del negocio
 * principal (raíz de la organización).
 *
 * Esta función devuelve:
 *   - salesBizId   : el business_id donde realmente están las ventas
 *   - articleIds   : array de IDs de artículos del subnegocio (para filtrar),
 *                    o null si hay que traer todos (caso negocio principal)
 * ───────────────────────────────────────────────────────────────────────── */
async function resolveSalesBusiness(biz) {
  // Si el negocio no es un subnegocio creado desde grupo, devolvemos tal cual
  if (biz.created_from !== 'from_group' || !biz.organization_id) {
    return { salesBizId: biz.id, articleIds: null };
  }

  // Es un subnegocio — buscar el negocio raíz de la organización
  const { rows: rootRows } = await pool.query(
    `SELECT id FROM app_businesses
      WHERE organization_id = $1
        AND (created_from IS NULL OR created_from = 'manual' OR created_from = 'onboarding')
      ORDER BY id ASC
      LIMIT 1`,
    [biz.organization_id]
  );

  const salesBizId = rootRows[0]?.id ?? biz.id;

  // Obtener los article_id del subnegocio SOLO desde sus agrupaciones.
  // NO usar maxi_articles del subnegocio porque tiene copia completa del catálogo
  // y causaría que se muestren todas las ventas del principal en el subnegocio.
  // Las ventas de un subnegocio = únicamente artículos en sus agrupaciones propias.
  const { rows: artRows } = await pool.query(
    `SELECT DISTINCT (elem->>'id')::bigint AS article_id
       FROM agrupaciones,
            jsonb_array_elements(
              CASE WHEN articulos IS NOT NULL AND articulos::text != 'null'
                   THEN articulos::jsonb ELSE '[]'::jsonb END
            ) AS elem
      WHERE business_id = $1
        AND moved_to_business_id IS NULL
        AND (elem->>'id') IS NOT NULL
        AND (elem->>'id') ~ '^[0-9]+$'
        AND (elem->>'id')::bigint > 0`,
    [biz.id]
  );

  const articleIds = artRows
    .map(r => Number(r.article_id))
    .filter(n => Number.isFinite(n) && n > 0);

  console.log(`[resolveSalesBusiness] Subnegocio ${biz.id} → salesBizId=${salesBizId}, artículos=${articleIds.length}`);

  // Si no encontramos artículos, devolvemos null para NO filtrar (mejor mostrar todo que nada)
  return {
    salesBizId,
    articleIds: articleIds.length > 0 ? articleIds : null,
  };
}

function parseDate(zd, fb) {
  if (!zd) return fb;
  const d = zd instanceof Date ? zd : new Date(zd);
  return Number.isNaN(d.getTime()) ? fb : d;
}

function clampToYesterday(a, b) {
  const today = new Date();
  const AYER = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  return { from: a, to: b > AYER ? AYER : b };
}

/* ===================== Handlers ===================== */

/** GET /api/businesses/:id/maxi-ping */
exports.maxiPing = async (req, res) => {
  try {
    const biz = req.business;
    
    // Si hay credenciales en DB o header X-Maxi-Token, esto devuelve token válido o lanza
    const token = await getBearer(biz.id, req);
    const props = biz?.props || {};
    const mx = props.maxi || props.maxi_credentials || {};
    
    return res.json({
      ok: true,
      configured: !!(mx?.email && (mx?.codcli || mx?.cod_cli)),
      connected: !!token,
      email: mx?.email || null,
      codcli: mx?.codcli || mx?.cod_cli || null,
    });
  } catch (e) {
    return res.json({ 
      ok: false, 
      configured: false, 
      connected: false, 
      error: e.message || 'ping_failed' 
    });
  }
};

/** POST /api/businesses/:id/sync-sales/window  body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', dryrun?: boolean } */
exports.syncWindow = async (req, res) => {
  try {
    const biz = req.business;

    // 1) Normalizar from/to desde body o query
    const fromRaw = String(
      (req.body && req.body.from) || (req.query && req.query.from) || ''
    ).slice(0, 10);

    const toRaw = String(
      (req.body && req.body.to) || (req.query && req.query.to) || ''
    ).slice(0, 10);

    if (!fromRaw || !toRaw) {
      return res.status(400).json({ ok: false, error: 'from_to_required' });
    }

    // 2) Clamp hasta AYER
    const defFrom = new Date(`${fromRaw}T00:00:00Z`);
    const defTo = new Date(`${toRaw}T00:00:00Z`);

    const { from: Fd, to: Td } = clampToYesterday(defFrom, defTo);
    const F = ymd(Fd);
    const T = ymd(Td);

    // 3) Flag de dryrun desde body o query
    const dryrun = !!(
      (req.body && req.body.dryrun) ||
      (req.query && (req.query.dryrun === '1' || String(req.query.dryrun).toLowerCase() === 'true'))
    );

    // 4) Traer ventas crudas desde Maxi para ese rango exacto
    const rawDocs = await fetchSalesRanged({
      businessId: biz.id,
      from: F,
      to: T,
      req,
    });

    // Si querés diagnosticar sin tocar DB
    if (dryrun) {
      return res.json({
        ok: true,
        dryrun: true,
        business_id: String(biz.id),
        from: F,
        to: T,
        count: Array.isArray(rawDocs) ? rawDocs.length : 0,
        sample: Array.isArray(rawDocs) ? rawDocs.slice(0, 3) : [],
      });
    }

    // 5) Upsert completo dentro de transacción (ventas + items diarios)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // upsertSalesBatch debe devolver { upserted, updated, minDay, maxDay }
      const result = await upsertSalesBatch(biz.id, rawDocs, client);

      await client.query('COMMIT');

      return res.json({
        ok: true,
        business_id: String(biz.id),
        from: F,
        to: T,
        ...result, // upserted, updated, minDay, maxDay
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('syncWindow error:', e);
    return res
      .status(e.status || 500)
      .json({ error: 'internal', message: e.message || 'sync_window_failed' });
  }
};

/** POST /api/businesses/:id/sync-sales/backfill-once */
exports.backfillOnce = async (req, res) => {
  try {
    const biz = req.business;
    const days = req.body?.days ? Number(req.body.days) : undefined;

    const out = await ensureInitialBackfillOnce({ businessId: biz.id, req, days });
    return res.json({ ok: true, business_id: String(biz.id), ...out });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'backfill_failed' });
  }
};

/** POST /api/businesses/:id/sync-sales/daily-auto */
exports.dailyAuto = async (req, res) => {
  try {
    const biz = req.business;
    const out = await runDailyAuto({ businessId: biz.id, req });
    return res.json({ ok: true, business_id: String(biz.id), ...out });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'daily_auto_failed' });
  }
};

/** POST /api/businesses/:id/sync-sales/rebuild-aggregates  body: { from, to } */
exports.rebuildAggregates = async (req, res) => {
  try {
    const biz = req.business;
    const F = String(req.body?.from || req.query?.from || '').slice(0, 10);
    const T = String(req.body?.to || req.query?.to || '').slice(0, 10);
    if (!F || !T) return res.status(400).json({ ok: false, error: 'from_to_required' });

    await upsertDailyAggregates(biz.id, F, T);
    return res.json({ ok: true, business_id: String(biz.id), from: F, to: T, rebuilt: true });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'rebuild_failed' });
  }
};

exports.syncSalesForBusiness = async (biz, body = {}, req) => {
  const {
    mode = 'auto',
    from,
    to,
    dryrun = false,
  } = body || {};

  // 1) Ventana explícita
  if (from && to) {
    const defFrom = new Date(`${from}T00:00:00Z`);
    const defTo = new Date(`${to}T00:00:00Z`);
    const { from: Fd, to: Td } = clampToYesterday(defFrom, defTo);
    const F = ymd(Fd), T = ymd(Td);

    const rawDocs = await fetchSalesRanged({
      businessId: biz.id,
      from: F,
      to: T,
      req,
    });

    if (dryrun) {
      return { ok: true, from: F, to: T, upserted: 0, updated: 0, preview: rawDocs.slice(0, 3) };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await upsertSalesBatch(biz.id, rawDocs, client);
      await client.query('COMMIT');
      return { ok: true, from: F, to: T, ...result };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { }
      throw e;
    } finally {
      client.release();
    }
  }

  // 2) Despacho por modo
  switch (String(mode).toLowerCase()) {
    case 'rebuild-aggregates': {
      if (!from || !to) {
        const err = new Error('from/to required for rebuild-aggregates');
        err.status = 400;
        throw err;
      }
      await upsertDailyAggregates(biz.id, from.slice(0, 10), to.slice(0, 10));
      return { ok: true, from: from.slice(0, 10), to: to.slice(0, 10), rebuilt: true };
    }

    case 'backfill_30d': {
      const out = await ensureInitialBackfillOnce({ businessId: biz.id, days: 30, req });
      return { ok: true, ...out };
    }

    case 'backfill': {
      const out = await ensureInitialBackfillOnce({ businessId: biz.id, req });
      return { ok: true, ...out };
    }

    case 'window': {
      const err = new Error('from/to required for window');
      err.status = 400;
      throw err;
    }

    case 'auto':
    default: {
      const out = await runDailyAuto({ businessId: biz.id, req });
      return { ok: true, ...out };
    }
  }
};

exports.reconcileAndRebuild = async (req, res, next) => {
  try {
    const biz = req.business;
    const { from, to } = req.body || {};
    
    const client = await require('../config/db').connect();
    try {
      await client.query('BEGIN');
      await require('../services/salesStore')
        .reconcileSalesMappings(client, biz.id, { fromYmd: from, toYmd: to });
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { }
      throw e;
    } finally {
      client.release();
    }
    
    await require('../services/salesStore').upsertDailyAggregates(biz.id, from, to);
    res.json({ ok: true, business_id: String(biz.id), from, to, reconciled: true, rebuilt: true });
  } catch (e) { next(e); }
};

// ============================================================================
// LISTADO DE VENTAS DIARIAS
// ============================================================================

/**
 * GET /api/businesses/:id/sales/daily-items
 * Query params:
 * - from, to (YYYY-MM-DD) - requeridos
 * - articleId (opcional) - filtrar por artículo específico
 * - groupIds (opcional) - filtrar por grupos: "1,2,3"
 * - limit, offset (paginación)
 * - source (csv|maxi)
 */
exports.listDailyItems = async (req, res, next) => {
  try {
    const biz = req.business;
    const {
      from,
      to,
      articleId,
      groupIds, // 🆕 Filtro por grupos (viene del frontend)
      limit = 500000,
      offset = 0,
      source = null,
    } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'from y to son requeridos (YYYY-MM-DD)'
      });
    }

    // 🔑 Resolver dónde están las ventas (subnegocio → negocio raíz)
    const { salesBizId, articleIds: subBizArticleIds } = await resolveSalesBusiness(biz);

    const params = [salesBizId, from, to];
    let whereClause = '';
    let groupFilter = '';

    // Filtro por artículo específico (tiene prioridad sobre filtro de subnegocio)
    if (articleId) {
      params.push(Number(articleId));
      whereClause = `AND sdi.article_id = $${params.length}`;
    } else if (subBizArticleIds) {
      // Filtro automático por artículos del subnegocio
      params.push(subBizArticleIds);
      whereClause = `AND sdi.article_id = ANY($${params.length})`;
    }

    // Filtro por source
    let sourceFilter = '';
    if (source) {
      params.push(source);
      sourceFilter = `AND sdi.source = $${params.length}`;
    }

    // 🆕 Filtro por grupos (viene del frontend cuando está en una división)
    if (groupIds) {
      const ids = String(groupIds).split(',').map(Number).filter(n => Number.isFinite(n));
      if (ids.length > 0) {
        params.push(ids);
        groupFilter = `
          AND sdi.article_id IN (
            SELECT DISTINCT article_id 
            FROM article_groups 
            WHERE group_id = ANY($${params.length})
          )
        `;
      }
    }

    // JOIN de nombres: buscar en salesBizId y biz.id (subnegocio tiene artículos copiados)
    const nameBizIds = salesBizId !== biz.id ? [salesBizId, biz.id] : [salesBizId];
    params.push(nameBizIds);
    const nameBizParam = `$${params.length}`;

    // Para el sqlTotals usamos los mismos params excepto el último (nameBizIds)
    const paramsTotals = params.slice(0, params.length - 1);

    // Query principal
    // IMPORTANTE: el JOIN de nombres se hace DESPUÉS del GROUP BY para evitar
    // que maxi_articles con múltiples business_id duplique filas y multiplique qty/amount
    const sql = `
      WITH agg AS (
        SELECT
          sdi.day::date AS day,
          sdi.article_id,
          SUM(sdi.qty)::numeric    AS qty,
          SUM(sdi.amount)::numeric AS amount
        FROM sales_daily_items sdi
        WHERE sdi.business_id = $1
          AND sdi.day BETWEEN $2::date AND $3::date
          ${whereClause}
          ${sourceFilter}
          ${groupFilter}
        GROUP BY sdi.day::date, sdi.article_id
      )
      SELECT
        agg.day,
        agg.article_id,
        COALESCE(
          NULLIF(TRIM(ma.nombre), ''),
          NULLIF(TRIM(aa.name), ''),
          '#' || agg.article_id::text
        ) AS title,
        agg.qty,
        agg.amount
      FROM agg
      LEFT JOIN LATERAL (
        SELECT nombre FROM maxi_articles
        WHERE articulo_id = agg.article_id
          AND business_id = ANY(${nameBizParam})
          AND nombre IS NOT NULL AND TRIM(nombre) <> ''
        LIMIT 1
      ) ma ON true
      LEFT JOIN LATERAL (
        SELECT name FROM app_articles
        WHERE id = agg.article_id
          AND business_id = ANY(${nameBizParam})
          AND name IS NOT NULL AND TRIM(name) <> ''
        LIMIT 1
      ) aa ON true
      ORDER BY agg.day DESC, agg.article_id
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}
    `;

    // Query de totales (sin el nameBizParam)
    const sqlTotals = `
      SELECT
        COUNT(DISTINCT sdi.article_id) AS rows_total,
        SUM(sdi.qty)::numeric AS qty_total,
        SUM(sdi.amount)::numeric AS amount_total
      FROM sales_daily_items sdi
      WHERE sdi.business_id = $1
        AND sdi.day BETWEEN $2::date AND $3::date
        ${whereClause}
        ${sourceFilter}
        ${groupFilter}
    `;

    const [rows, totals] = await Promise.all([
      pool.query(sql, params).then(r => r.rows),
      pool.query(sqlTotals, paramsTotals).then(r => r.rows[0]),
    ]);

    res.json({
      ok: true,
      business_id: String(biz.id),
      from,
      to,
      filters: {
        articleId: articleId ? Number(articleId) : null,
        groupIds: groupIds || null,
        source: source || null,
      },
      totals: {
        rows_total: Number(totals?.rows_total || 0),
        qty_total: Number(totals?.qty_total || 0),
        amount_total: Number(totals?.amount_total || 0),
      },
      items: rows,
    });
  } catch (e) {
    console.error('[listDailyItems] error:', e);
    next(e);
  }
};

// ============================================================================
// EXPORTAR CSV
// ============================================================================

/**
 * GET /api/businesses/:id/sales/export-csv
 * Query: from, to, groupIds (opcional)
 */
exports.exportSalesCsv = async function exportSalesCsv(req, res) {
  try {
    const rawBizId = Number(req.params.id);
    const { from, to, groupIds } = req.query;

    if (!Number.isFinite(rawBizId)) {
      return res.status(400).json({ error: 'businessId inválido' });
    }
    if (!from || !to) {
      return res.status(400).json({
        error: 'from y to son obligatorios (YYYY-MM-DD)'
      });
    }

    // Resolver subnegocio → principal (igual que listDailyItems)
    const bizRow = await pool.query(
      `SELECT id, created_from, organization_id FROM app_businesses WHERE id = $1`, [rawBizId]
    );
    const biz = bizRow.rows[0] || { id: rawBizId };
    const { salesBizId, articleIds: subBizArticleIds } = await resolveSalesBusiness(biz);

    const params = [salesBizId, from, to];
    let articleFilter = '';
    let groupFilter = '';

    // Filtro por artículos del subnegocio
    if (subBizArticleIds) {
      params.push(subBizArticleIds);
      articleFilter = `AND sdi.article_id = ANY($${params.length})`;
    }

    // Filtro por grupos si viene
    if (groupIds) {
      const ids = String(groupIds).split(',').map(Number).filter(n => Number.isFinite(n));
      if (ids.length > 0) {
        params.push(ids);
        groupFilter = `
          AND sdi.article_id IN (
            SELECT DISTINCT article_id 
            FROM article_groups 
            WHERE group_id = ANY($${params.length})
          )
        `;
      }
    }

    const sql = `
      SELECT
        sdi.article_id AS codigo,
        COALESCE(
         NULLIF(TRIM(MAX(ma.nombre)), ''), 
         NULLIF(TRIM(MAX(aa.name)), ''),
          'Artículo #' || sdi.article_id::text
        ) AS nombre,
        SUM(sdi.qty)::numeric AS unidades,
        SUM(sdi.amount)::numeric AS importe,
        0 AS costo,
        0 AS p_total,
        0 AS neto,
        NULL AS tipo_iva,
        sdi.day::date AS fecha
      FROM sales_daily_items sdi
      LEFT JOIN maxi_articles ma
        ON ma.business_id = sdi.business_id 
        AND ma.articulo_id = sdi.article_id
      LEFT JOIN app_articles aa
        ON aa.business_id = sdi.business_id
        AND aa.id = sdi.article_id
      WHERE sdi.business_id = $1
        AND sdi.day BETWEEN $2::date AND $3::date
        ${articleFilter}
        ${groupFilter}
      GROUP BY sdi.day::date, sdi.article_id 
      ORDER BY sdi.day ASC, sdi.article_id ASC;
    `;

    const { rows } = await pool.query(sql, params);

    // Headers CSV
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ventas_${rawBizId}_${from}_a_${to}.csv"`
    );

    // BOM UTF-8 para Excel
    res.write('\uFEFF');

    const headers = [
      'codigo',
      'nombre',
      'unidades',
      'importe',
      'costo',
      'p_total',
      'neto',
      'tipo_iva',
      'fecha'
    ];
    res.write(headers.join(',') + '\n');

    // Escribir filas
    for (const r of rows) {
      try {
        const fecha = r.fecha instanceof Date
          ? r.fecha.toISOString().slice(0, 10)
          : String(r.fecha || '').slice(0, 10);

        const line = [
          csvEscape(r.codigo),
          csvEscape(r.nombre),
          csvEscape(Number(r.unidades || 0)),
          csvEscape(Number(r.importe || 0).toFixed(2)),
          csvEscape(Number(r.costo || 0)),
          csvEscape(Number(r.p_total || 0)),
          csvEscape(Number(r.neto || 0)),
          csvEscape(r.tipo_iva || ''),
          csvEscape(fecha)
        ].join(',');

        res.write(line + '\n');
      } catch (rowErr) {
        console.error('[exportSalesCsv] error fila:', rowErr);
      }
    }

    return res.end();

  } catch (e) {
    console.error('[exportSalesCsv] error:', e);
    res.status(500).json({
      error: 'Error exportando CSV',
      detail: e?.message || String(e)
    });
  }
};

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[,"\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * 🔍 DIAGNÓSTICO: Ver datos crudos de MaxiRest
 * GET /api/businesses/:id/sync-sales/diagnostic-raw?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
exports.diagnosticRaw = async (req, res) => {
  try {
    const biz = req.business;
    const from = req.query.from || '2025-12-01';
    const to = req.query.to || '2025-12-02';

    console.log('\n========================================');
    console.log('=== DIAGNÓSTICO DE VENTAS CRUDAS ===');
    console.log('========================================');
    console.log('businessId:', biz.id);
    console.log('from:', from);
    console.log('to:', to);
    console.log('----------------------------------------\n');

    const raw = await fetchSalesRanged({
      businessId: biz.id,
      from,
      to,
      req
    });

    console.log('=== CANTIDAD DE ITEMS ===');
    console.log('Total facturas/ordenes:', raw.length);

    if (raw.length > 0) {
      console.log('\n=== PRIMERA FACTURA/ORDEN (estructura completa) ===');
      console.log(JSON.stringify(raw[0], null, 2));

      if (raw[1]) {
        console.log('\n=== SEGUNDA FACTURA/ORDEN ===');
        console.log(JSON.stringify(raw[1], null, 2));
      }

      if (raw[2]) {
        console.log('\n=== TERCERA FACTURA/ORDEN ===');
        console.log(JSON.stringify(raw[2], null, 2));
      }
    }

    console.log('\n========================================\n');

    res.json({
      success: true,
      business_id: biz.id,
      from,
      to,
      total: raw.length,
      muestra: {
        primera: raw[0] || null,
        segunda: raw[1] || null,
        tercera: raw[2] || null
      },
      primeras_5: raw.slice(0, 5)
    });

  } catch (error) {
    console.error('❌ Error en diagnóstico:', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

// ============================================================================
// RESUMEN DE VENTAS
// ============================================================================

/**
 * GET /api/businesses/:id/sales/summary
 * Query: from, to, source, groupIds (opcional), articleIds (opcional)
 */
exports.salesSummary = async (req, res, next) => {
  try {
    const biz = req.business;
    const {
      from,
      to,
      source = 'csv',
      articleIds = null,
      groupIds = null, // 🆕 Filtro por grupos
    } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'from y to son requeridos (YYYY-MM-DD)'
      });
    }

    // 🔑 Resolver dónde están las ventas (subnegocio → negocio raíz)
    const { salesBizId, articleIds: subBizArticleIds } = await resolveSalesBusiness(biz);

    const params = [salesBizId, from, to, source];
    let articleFilter = '';
    let groupFilter = '';

    // Filtro automático por artículos del subnegocio
    if (subBizArticleIds) {
      params.push(subBizArticleIds);
      articleFilter = `AND sdi.article_id = ANY($${params.length})`;
    }

    // Filtro por artículos específicos (del query, override del subnegocio)
    if (articleIds && !subBizArticleIds) {
      const ids = String(articleIds).split(',').map(Number).filter(n => Number.isFinite(n));
      if (ids.length > 0) {
        params.push(ids);
        articleFilter = `AND sdi.article_id = ANY($${params.length})`;
      }
    }

    // 🆕 Filtro por grupos
    if (groupIds) {
      const ids = String(groupIds).split(',').map(Number).filter(n => Number.isFinite(n));
      if (ids.length > 0) {
        params.push(ids);
        groupFilter = `
          AND sdi.article_id IN (
            SELECT DISTINCT article_id 
            FROM article_groups 
            WHERE group_id = ANY($${params.length})
          )
        `;
      }
    }

    // Para el JOIN de nombres: buscamos en salesBizId Y en biz.id (por si los artículos
    // están copiados en el subnegocio con su propio business_id)
    const nameBizIds = salesBizId !== biz.id ? [salesBizId, biz.id] : [salesBizId];
    params.push(nameBizIds);
    const nameBizParam = `$${params.length}`;

    // IMPORTANTE: igual que listDailyItems, separamos el JOIN de nombres del SUM
    // para evitar que maxi_articles con múltiples business_id duplique qty/amount
    const sql = `
      WITH agg AS (
        SELECT
          sdi.article_id,
          SUM(sdi.qty)::numeric         AS total_qty,
          SUM(sdi.amount)::numeric      AS total_amount,
          COUNT(DISTINCT sdi.day)       AS days_with_sales,
          MIN(sdi.day)::date            AS first_sale,
          MAX(sdi.day)::date            AS last_sale
        FROM sales_daily_items sdi
        WHERE sdi.business_id = $1
          AND sdi.day BETWEEN $2::date AND $3::date
          AND sdi.source = $4
          ${articleFilter}
          ${groupFilter}
        GROUP BY sdi.article_id
        HAVING SUM(sdi.qty) > 0
      )
      SELECT
        agg.article_id,
        COALESCE(
          NULLIF(TRIM(ma.nombre), ''),
          NULLIF(TRIM(aa.name), ''),
          '#' || agg.article_id::text
        ) AS title,
        agg.total_qty,
        agg.total_amount,
        agg.days_with_sales,
        agg.first_sale,
        agg.last_sale
      FROM agg
      LEFT JOIN LATERAL (
        SELECT nombre FROM maxi_articles
        WHERE articulo_id = agg.article_id
          AND business_id = ANY(${nameBizParam})
          AND nombre IS NOT NULL AND TRIM(nombre) <> ''
        LIMIT 1
      ) ma ON true
      LEFT JOIN LATERAL (
        SELECT name FROM app_articles
        WHERE id = agg.article_id
          AND business_id = ANY(${nameBizParam})
          AND name IS NOT NULL AND TRIM(name) <> ''
        LIMIT 1
      ) aa ON true
      ORDER BY agg.total_qty DESC
    `;

    const { rows } = await pool.query(sql, params);

    // Calcular totales globales
    const totals = rows.reduce((acc, row) => {
      acc.total_qty += Number(row.total_qty || 0);
      acc.total_amount += Number(row.total_amount || 0);
      return acc;
    }, { total_qty: 0, total_amount: 0 });

    res.json({
      ok: true,
      business_id: String(biz.id),
      from,
      to,
      source,
      filters: {
        groupIds: groupIds || null,
        articleIds: articleIds || null,
      },
      totals: {
        articles_count: rows.length,
        total_qty: totals.total_qty,
        total_amount: totals.total_amount,
      },
      items: rows,
    });
  } catch (e) {
    console.error('[salesSummary] error:', e);
    next(e);
  }
};

/* ══════════════════════════════════════════════════════════
   GET /api/businesses/:id/sales/first-date
   Devuelve la primera fecha con ventas del negocio (o del principal si es subnegocio).
   Usado por el selector de calendario para el rango "Histórico".
══════════════════════════════════════════════════════════ */
exports.getFirstSaleDate = async (req, res, next) => {
  try {
    const biz = req.business;
    if (!biz?.id) return res.status(400).json({ error: 'no_business' });

    const { salesBizId } = await resolveSalesBusiness(biz);

    const { rows } = await pool.query(
      `SELECT MIN(day)::date AS first_date
         FROM sales_daily_items
        WHERE business_id = $1`,
      [salesBizId]
    );

    const firstDate = rows[0]?.first_date || null;

    return res.json({ ok: true, first_date: firstDate, sales_biz_id: salesBizId });
  } catch (e) {
    next(e);
  }
};

module.exports = {
  maxiPing: exports.maxiPing,
  syncWindow: exports.syncWindow,
  backfillOnce: exports.backfillOnce,
  dailyAuto: exports.dailyAuto,
  rebuildAggregates: exports.rebuildAggregates,
  syncSalesForBusiness: exports.syncSalesForBusiness,
  reconcileAndRebuild: exports.reconcileAndRebuild,
  listDailyItems: exports.listDailyItems,
  exportSalesCsv: exports.exportSalesCsv,
  diagnosticRaw: exports.diagnosticRaw,
  salesSummary: exports.salesSummary,
  getFirstSaleDate: exports.getFirstSaleDate,  
};