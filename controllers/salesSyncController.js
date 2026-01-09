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
    return res.json({ ok: false, configured: false, connected: false, error: e.message || 'ping_failed' });
  }
};

/** POST /api/businesses/:id/sync-sales/window  body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', dryrun?: boolean } */
// controllers/salesSyncController.js

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

    // 2) Clamp hasta AYER (mantengo tu lógica)
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
      // Corre tu política automática (usa INIT_BACKFILL_DAYS y luego incremental)
      const out = await runDailyAuto({ businessId: biz.id, req });
      return { ok: true, ...out };
    }
  }
};

exports.reconcileAndRebuild = async (req, res, next) => {
  try {
    const biz = req.business;
    const { from, to } = req.body || {};
    // 1) reconciliar mappings (usa tu helper actual)
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
    // 2) rebuild agregados
    await require('../services/salesStore').upsertDailyAggregates(biz.id, from, to);
    res.json({ ok: true, business_id: String(biz.id), from, to, reconciled: true, rebuilt: true });
  } catch (e) { next(e); }
};

// ============================================================================
// FIX: listDailyItems con doble JOIN (maxi_articles + app_articles)
// ============================================================================

exports.listDailyItems = async (req, res, next) => {
  try {
    const biz = req.business;
    const {
      from,
      to,
      articleId,
      limit = 10000,
      offset = 0,
      source = null,
    } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'from y to son requeridos (YYYY-MM-DD)'
      });
    }

    const params = [biz.id, from, to];
    let whereClause = '';

    if (articleId) {
      params.push(Number(articleId));
      whereClause = `AND sdi.article_id = $${params.length}`;
    }

    let sourceFilter = '';
    if (source) {
      params.push(source);
      sourceFilter = `AND sdi.source = $${params.length}`;
    }

    // ✅ QUERY principal
    const sql = `
      SELECT
        sdi.day::date AS day,
        sdi.article_id,
        COALESCE(
          NULLIF(TRIM(ma.nombre), ''),
          NULLIF(TRIM(aa.name), ''),
          '#' || sdi.article_id::text
        ) AS title,
        SUM(sdi.qty)::numeric AS qty,
        SUM(sdi.amount)::numeric AS amount
      FROM sales_daily_items sdi
      LEFT JOIN maxi_articles ma
        ON ma.business_id = sdi.business_id 
        AND ma.articulo_id = sdi.article_id
      LEFT JOIN app_articles aa
        ON aa.business_id = sdi.business_id
        AND aa.id = sdi.article_id
      WHERE sdi.business_id = $1
        AND sdi.day BETWEEN $2::date AND $3::date
        ${whereClause}
        ${sourceFilter}
      GROUP BY sdi.day::date, sdi.article_id, ma.nombre, aa.name
      ORDER BY sdi.day DESC, sdi.article_id
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}
    `;

    // ✅ Query de totales (AGREGAR sourceFilter)
    const sqlTotals = `
      SELECT
        COUNT(DISTINCT sdi.article_id) AS rows_total,
        SUM(sdi.qty)::numeric AS qty_total,
        SUM(sdi.amount)::numeric AS amount_total
      FROM sales_daily_items sdi
      WHERE sdi.business_id = $1
        AND sdi.day BETWEEN $2::date AND $3::date
        ${whereClause}
        ${sourceFilter}  -- ✅ AGREGAR ESTA LÍNEA
    `;

    const pool = require('../config/db');

    const [rows, totals] = await Promise.all([
      pool.query(sql, params).then(r => r.rows),
      pool.query(sqlTotals, params).then(r => r.rows[0]),
    ]);

    res.json({
      ok: true,
      business_id: String(biz.id),
      from,
      to,
      filters: {
        articleId: articleId ? Number(articleId) : null,
        source: source || null,  // ✅ Incluir en respuesta
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
// VERSIÓN FINAL: exportSalesCsv SIN DISCOUNT
// Para usar en: controllers/salesSyncController.js
// ============================================================================

exports.exportSalesCsv = async function exportSalesCsv(req, res) {
  try {
    const businessId = Number(req.params.id);
    const { from, to } = req.query;

    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ error: 'businessId inválido' });
    }
    if (!from || !to) {
      return res.status(400).json({
        error: 'from y to son obligatorios (YYYY-MM-DD)'
      });
    }

    const pool = require('../config/db');

    // ========================================
    // FORMATO MAXI v7: Agregado por día-artículo
    // ========================================
    const sql = `
      SELECT
        sdi.article_id AS codigo,
        COALESCE(
          NULLIF(TRIM(ma.nombre), ''),
          NULLIF(TRIM(aa.name), ''),
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
        AND sdi.source = 'csv'
        AND sdi.day BETWEEN $2::date AND $3::date
      GROUP BY sdi.day::date, sdi.article_id, ma.nombre, aa.name
      ORDER BY sdi.day ASC, sdi.article_id ASC;
    `;

    const { rows } = await pool.query(sql, [businessId, from, to]);

    // Headers CSV
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ventas_${businessId}_${from}_a_${to}.csv"`
    );

    // BOM UTF-8 para Excel
    res.write('\uFEFF');

    // 🎯 HEADERS IDÉNTICOS A v7
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

    // Traer datos crudos de MaxiRest
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

    // Respuesta HTTP para ver en Postman/navegador
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
      // Solo las primeras 5 completas para no saturar
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
  diagnosticRaw: exports.diagnosticRaw, // 👈 AGREGAR ESTA LÍNEA
};