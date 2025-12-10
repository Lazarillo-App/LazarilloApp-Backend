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

exports.listDailyItems = async (req, res, next) => {
  try {
    const biz = req.business; // seteado por requireBusinessAccessParam
    const {
      from,
      to,
      articleId,
      q,
      limit = 500,
      offset = 0,
    } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: 'bad_request', message: 'from y to son requeridos (YYYY-MM-DD)' });
    }

    const params = [biz.id, from, to];
    const filters = [
      `sdi.business_id = $1`,
      `sdi.day BETWEEN $2::date AND $3::date`
    ];

    if (articleId) {
      params.push(Number(articleId));
      filters.push(`sdi.article_id = $${params.length}`);
    }

    // Búsqueda por título (segura con to_jsonb->> por si tu esquema no tiene 'title' exactamente)
    if (q && String(q).trim()) {
      params.push(`%${String(q).trim()}%`);
      const pIdx = params.length;
      filters.push(`
        COALESCE(
          to_jsonb(a)->>'title',
          to_jsonb(a)->>'name',
          to_jsonb(a)->>'nombre',
          to_jsonb(a)->>'descripcion',
          to_jsonb(a)->>'descripcion_corta',
          to_jsonb(a)->>'descrip',
          ''
        ) ILIKE $${pIdx}
      `);
    }

    // Principales filas
    const sql = `
WITH
unknown_items AS (
  SELECT
    sdi.day::date AS day,
    UPPER(TRIM(COALESCE(sdi.article_title, sdi.title, sdi.name, ''))) AS maxi_nombre_norm,
    SUM(sdi.qty)::numeric AS qty,
    SUM(sdi.amount)::numeric AS amount
  FROM sales_daily_items sdi
  WHERE sdi.business_id = $1
    AND sdi.day BETWEEN $2::date AND $3::date
    AND (sdi.article_id IS NULL OR sdi.article_id = 0)
  GROUP BY sdi.day::date, UPPER(TRIM(COALESCE(sdi.article_title, sdi.title, sdi.name, '')))
),

unknown_resolved AS (
  SELECT
    ui.day,
    ui.maxi_nombre_norm,
    ma.articulo_id AS resolved_article_id,
    ui.qty,
    ui.amount
  FROM unknown_items ui
  JOIN public.maxi_articles ma
    ON ma.business_id = $1
   AND UPPER(TRIM(ma.nombre)) = ui.maxi_nombre_norm

  UNION ALL

  SELECT
    ui.day,
    ui.maxi_nombre_norm,
    a.id AS resolved_article_id,
    ui.qty,
    ui.amount
  FROM unknown_items ui
  LEFT JOIN public.maxi_articles ma2
    ON ma2.business_id = $1 AND UPPER(TRIM(ma2.nombre)) = ui.maxi_nombre_norm
  JOIN app_articles a
    ON a.business_id = $1
   AND UPPER(TRIM(COALESCE(a.name, a.nombre, ''))) = ui.maxi_nombre_norm
  WHERE ma2.articulo_id IS NULL
),

unknown_resolved_agg AS (
  SELECT day, resolved_article_id::bigint AS article_id, SUM(qty)::numeric AS qty, SUM(amount)::numeric AS amount
  FROM unknown_resolved
  GROUP BY day, resolved_article_id
),

known_agg AS (
  SELECT sdi.day::date AS day, sdi.article_id::bigint AS article_id, SUM(sdi.qty)::numeric AS qty, SUM(sdi.amount)::numeric AS amount
  FROM sales_daily_items sdi
  WHERE sdi.business_id = $1
    AND sdi.day BETWEEN $2::date AND $3::date
    AND COALESCE(sdi.article_id,0) <> 0
  GROUP BY sdi.day::date, sdi.article_id
),

merged AS (
  SELECT COALESCE(k.day,u.day) AS day, COALESCE(k.article_id,u.article_id) AS article_id,
         COALESCE(k.qty,0)+COALESCE(u.qty,0) AS qty, COALESCE(k.amount,0)+COALESCE(u.amount,0) AS amount
  FROM known_agg k
  FULL JOIN unknown_resolved_agg u ON k.day = u.day AND k.article_id = u.article_id
)

SELECT
  m.day,
  m.article_id,
  NULLIF(TRIM(COALESCE(ma.nombre, a.name, a.nombre)), '') AS article_title,
  m.qty,
  m.amount
FROM merged m
LEFT JOIN public.maxi_articles ma
  ON ma.business_id = $1 AND ma.articulo_id = m.article_id
LEFT JOIN app_articles a
  ON a.business_id = $1 AND a.id = m.article_id
ORDER BY m.day, m.article_id
LIMIT ${Number(limit)} OFFSET ${Number(offset)}
`;

    // Totales coherentes sobre merged
    const sqlTotals = `
WITH
-- (reutiliza las CTE anteriores, pero solo para totales)
unknown_items AS (
  SELECT
    UPPER(TRIM(COALESCE(sdi.article_title, sdi.title, sdi.name, ''))) AS maxi_nombre_norm,
    SUM(sdi.qty)::numeric AS qty,
    SUM(sdi.amount)::numeric AS amount
  FROM sales_daily_items sdi
  WHERE sdi.business_id = $1
    AND sdi.day BETWEEN $2::date AND $3::date
    AND (sdi.article_id IS NULL OR sdi.article_id = 0)
  GROUP BY UPPER(TRIM(COALESCE(sdi.article_title, sdi.title, sdi.name, '')))
),

unknown_resolved_agg AS (
  SELECT ura.resolved_article_id::bigint AS article_id, SUM(ui.qty)::numeric AS qty, SUM(ui.amount)::numeric AS amount
  FROM unknown_items ui
  JOIN (
    SELECT DISTINCT UPPER(TRIM(ma.nombre)) AS maxi_nombre_norm, ma.articulo_id
    FROM public.maxi_articles ma WHERE ma.business_id = $1
  ) ura ON ura.maxi_nombre_norm = ui.maxi_nombre_norm
  GROUP BY ura.resolved_article_id
),

known_agg AS (
  SELECT sdi.article_id::bigint AS article_id, SUM(sdi.qty)::numeric AS qty, SUM(sdi.amount)::numeric AS amount
  FROM sales_daily_items sdi
  WHERE sdi.business_id = $1
    AND sdi.day BETWEEN $2::date AND $3::date
    AND COALESCE(sdi.article_id,0) <> 0
  GROUP BY sdi.article_id
)

SELECT
  COALESCE(SUM(k.qty),0) + COALESCE(SUM(u.qty),0) AS qty_total,
  COALESCE(SUM(k.amount),0) + COALESCE(SUM(u.amount),0) AS amount_total,
  (SELECT COUNT(*) FROM (
      SELECT DISTINCT COALESCE(k.article_id, u.article_id) FROM known_agg k FULL JOIN unknown_resolved_agg u ON k.article_id = u.article_id
  ) t) AS rows_total
FROM (
  SELECT * FROM known_agg
) k
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(x.qty),0) AS qty, COALESCE(SUM(x.amount),0) AS amount
  FROM unknown_resolved_agg x
  WHERE x.article_id IS NOT NULL
) u
;
`;

    const [rows, totals] = await Promise.all([
      pool.query(sql, params).then(r => r.rows),
      pool.query(sqlTotals, params).then(r => r.rows[0]),
    ]);

    res.json({
      ok: true,
      business_id: String(biz.id),
      from,
      to,
      filters: { articleId: articleId ? Number(articleId) : null, q: q || null },
      totals,
      items: rows,
    });
  } catch (e) {
    next(e);
  }
};

// ============================================================================
// VERSIÓN FINAL: exportSalesCsv SIN DISCOUNT
// Para usar en: controllers/salesSyncController.js
// ============================================================================

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[;"\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

exports.exportSalesCsv = async function exportSalesCsv(req, res) {
  try {
    const businessId = Number(req.params.id);
    const { from, to, mode = 'detailed' } = req.query;

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
    // MODO DETALLADO (ventas individuales)
    // ========================================
    if (mode === 'detailed') {
      const sql = `
        SELECT
          s.external_id AS numero_venta,
          s.occurred_at::date AS fecha,
          EXTRACT(HOUR FROM s.occurred_at)::text || ':' || 
            LPAD(EXTRACT(MINUTE FROM s.occurred_at)::text, 2, '0') AS hora,
          s.total AS total_venta,
          
          si.line_pos AS linea,
          si.name AS articulo_nombre,
          si.sku AS articulo_codigo,
          si.qty AS cantidad,
          si.unit_price AS precio_unitario,
          si.amount AS subtotal,
          
          si.article_id AS articulo_id,
          m.categoria AS rubro,
          m.subrubro AS subrubro
          
        FROM app_sales s
        JOIN app_sales_items si ON si.sale_id = s.id
        LEFT JOIN maxi_article_map m 
          ON m.article_id = si.article_id 
          AND m.business_id = s.business_id
        
        WHERE s.business_id = $1
          AND s.occurred_at::date BETWEEN $2::date AND $3::date
          
        ORDER BY s.occurred_at, s.external_id, si.line_pos;
      `;

      const { rows } = await pool.query(sql, [businessId, from, to]);

      // Headers CSV
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="ventas_detalladas_${businessId}_${from}_${to}.csv"`
      );

      // BOM UTF-8 para Excel
      res.write('\uFEFF');

      const headers = [
        'numero_venta',
        'fecha',
        'hora',
        'total_venta',
        'linea',
        'articulo_nombre',
        'articulo_codigo',
        'cantidad',
        'precio_unitario',
        'subtotal',
        'articulo_id',
        'rubro',
        'subrubro'
      ];
      res.write(headers.join(';') + '\n');

      for (const r of rows) {
        try {
          const fecha = r.fecha instanceof Date 
            ? r.fecha.toISOString().slice(0, 10)
            : String(r.fecha || '').slice(0, 10);

          const line = [
            csvEscape(r.numero_venta),
            csvEscape(fecha),
            csvEscape(r.hora),
            csvEscape(r.total_venta || 0),
            csvEscape(r.linea),
            csvEscape(r.articulo_nombre),
            csvEscape(r.articulo_codigo),
            csvEscape(r.cantidad || 0),
            csvEscape(r.precio_unitario || 0),
            csvEscape(r.subtotal || 0),
            csvEscape(r.articulo_id),
            csvEscape(r.rubro),
            csvEscape(r.subrubro)
          ].join(';');

          res.write(line + '\n');
        } catch (rowErr) {
          console.error('[exportSalesCsv] error fila:', rowErr);
          res.write(csvEscape(businessId) + ';ERROR_SERIALIZING_ROW\n');
        }
      }

      return res.end();
    }

    // ========================================
    // MODO RESUMEN (agregado semanal)
    // ========================================
    if (mode === 'summary') {
      const sql = `
        WITH sdi2 AS (
          SELECT
            sdi.business_id,
            date_trunc('week', sdi.day)::date AS week_start,
            (date_trunc('week', sdi.day)::date + 6)::date AS week_end,
            sdi.article_id,
            SUM(sdi.qty)::numeric AS unidades,
            SUM(sdi.amount)::numeric AS venta
          FROM sales_daily_items sdi
          WHERE sdi.business_id = $1
            AND sdi.day::date BETWEEN $2::date AND $3::date
          GROUP BY sdi.business_id, 
                   date_trunc('week', sdi.day)::date, 
                   (date_trunc('week', sdi.day)::date + 6)::date, 
                   sdi.article_id
        )
        SELECT
          sdi2.business_id,
          to_char(sdi2.week_start, 'YYYY-MM-DD') || ' a ' || 
            to_char(sdi2.week_end, 'YYYY-MM-DD') AS fecha_semana,
          m.categoria AS rubro_nombre,
          m.subrubro AS subrubro_nombre,
          sdi2.article_id AS id_articulo_interno,
          m.articulo_id AS id_articulo_maxi,
          COALESCE(
            NULLIF(TRIM(m.nombre), ''),
            '#' || sdi2.article_id::text
          ) AS nombre_articulo,
          sdi2.unidades AS unidades,
          sdi2.venta AS venta
        FROM sdi2
        LEFT JOIN maxi_article_map m 
          ON m.article_id = sdi2.article_id 
          AND m.business_id = sdi2.business_id
        ORDER BY sdi2.week_start ASC, 
                 rubro_nombre NULLS LAST, 
                 subrubro_nombre NULLS LAST, 
                 nombre_articulo ASC;
      `;

      const { rows } = await pool.query(sql, [businessId, from, to]);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="ventas_semanales_${businessId}_${from}_${to}.csv"`
      );

      res.write('\uFEFF');

      const headers = [
        'business_id',
        'fecha_semana',
        'rubro',
        'subrubro',
        'id_articulo_interno',
        'id_articulo_maxi',
        'nombre_articulo',
        'unidades',
        'venta'
      ];
      res.write(headers.join(';') + '\n');

      for (const r of rows) {
        try {
          const line = [
            csvEscape(r.business_id),
            csvEscape(r.fecha_semana),
            csvEscape(r.rubro_nombre),
            csvEscape(r.subrubro_nombre),
            csvEscape(r.id_articulo_interno),
            csvEscape(r.id_articulo_maxi),
            csvEscape(r.nombre_articulo),
            csvEscape(r.unidades || 0),
            csvEscape(r.venta || 0)
          ].join(';');

          res.write(line + '\n');
        } catch (rowErr) {
          console.error('[exportSalesCsv] error fila:', rowErr);
          res.write(csvEscape(businessId) + ';ERROR_SERIALIZING_ROW\n');
        }
      }

      return res.end();
    }

    // Modo inválido
    return res.status(400).json({ 
      error: 'invalid_mode', 
      hint: 'use mode=detailed or mode=summary' 
    });

  } catch (e) {
    console.error('[exportSalesCsv] error completo:', e);
    res.status(500).json({ 
      error: 'Error exportando CSV', 
      detail: e?.message || String(e),
      stack: process.env.NODE_ENV === 'development' ? e.stack : undefined
    });
  }
};

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