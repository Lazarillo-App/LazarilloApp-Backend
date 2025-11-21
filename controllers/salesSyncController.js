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
    const defTo   = new Date(`${toRaw}T00:00:00Z`);

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
      try { await client.query('ROLLBACK'); } catch (_) {}
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
    const out = await ensureInitialBackfillOnce({ businessId: biz.id, req });
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
    windowDays,
  } = body || {};

  // 1) Ventana explícita
  if (from && to) {
    const defFrom = new Date(`${from}T00:00:00Z`);
    const defTo   = new Date(`${to}T00:00:00Z`);
    const { from: Fd, to: Td } = clampToYesterday(defFrom, defTo);
    const F = ymd(Fd), T = ymd(Td);

    const rawDocs = await fetchSalesRanged({
      businessId: biz.id,
      from: F,
      to: T,
      req,            // 👈 ahora sí entra el req si lo necesitás
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
      try { await client.query('ROLLBACK'); } catch {}
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
    case 'backfill_30d':
    case 'backfill': {
      // Corre tu backfill inicial (ajustá si tu política define otra ventana)
      const out = await ensureInitialBackfillOnce({ businessId: biz.id /*, req opcional */ });
      return { ok: true, ...out };
    }
    case 'window': {
      const err = new Error('from/to required for window');
      err.status = 400;
      throw err;
    }
    case 'auto':
    default: {
      // Corre tu política automática (normalmente últimos 7 días hasta ayer)
      const out = await runDailyAuto({ businessId: biz.id, windowDays /*, req opcional */ });
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
    const filters = [`sdi.business_id = $1`, `sdi.day BETWEEN $2 AND $3`];

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
      SELECT
        sdi.day,
        sdi.article_id,
        -- título “flexible” del catálogo
        NULLIF(TRIM(COALESCE(
          to_jsonb(a)->>'title',
          to_jsonb(a)->>'name',
          to_jsonb(a)->>'nombre',
          to_jsonb(a)->>'descripcion',
          to_jsonb(a)->>'descripcion_corta',
          to_jsonb(a)->>'descrip'
        )), '') AS article_title,
        sdi.qty,
        sdi.amount
      FROM sales_daily_items sdi
      LEFT JOIN app_articles a
        ON a.id = sdi.article_id
       AND a.business_id = sdi.business_id
      WHERE ${filters.join(' AND ')}
      ORDER BY sdi.day, sdi.article_id
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}
    `;

    // Totales del rango (para cabecera/footers en la UI)
    const sqlTotals = `
      SELECT
        COALESCE(SUM(sdi.qty), 0)::numeric AS qty_total,
        COALESCE(SUM(sdi.amount), 0)::numeric AS amount_total,
        COUNT(*)::int AS rows_total
      FROM sales_daily_items sdi
      LEFT JOIN app_articles a
        ON a.id = sdi.article_id
       AND a.business_id = sdi.business_id
      WHERE ${filters.join(' AND ')}
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

exports.adminSyncSales = async (req, res, next) => {
  try {
    const biz = req.business;
    const out = await exports.syncSalesForBusiness(biz, req.body || {}, req);
    res.json({ ok: true, business_id: biz.id, sales: out });
  } catch (e) {
    next(e);
  }
};

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[;"\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

exports.exportSalesCsv = async function exportSalesCsv(req, res) {
  try {
    const businessId = Number(req.params.id);
    const { from, to } = req.query;

    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ error: 'businessId inválido' });
    }
    if (!from || !to) {
      return res.status(400).json({ error: 'from y to son obligatorios (YYYY-MM-DD)' });
    }

    const sql = `
      SELECT
        d.business_id,
        d.date::date AS fecha,
        d.article_id,
        COALESCE(a.nombre, a.descripcion, a.nombre_maxi, '#'||d.article_id::text) AS articulo_nombre,
        COALESCE(a.codigo, a.codigo_maxi, a.articulo_codigo) AS articulo_codigo,
        SUM(d.qty)    AS qty,
        SUM(d.amount) AS amount
      FROM maxi_sales_daily d
      LEFT JOIN app_articles a
        ON a.business_id = d.business_id
       AND a.article_id_maxi = d.article_id
      WHERE d.business_id = $1
        AND d.date::date >= $2::date
        AND d.date::date <= $3::date
      GROUP BY
        d.business_id,
        fecha,
        d.article_id,
        articulo_nombre,
        articulo_codigo
      ORDER BY fecha ASC, articulo_nombre ASC;
    `;

    const { rows } = await pool.query(sql, [businessId, from, to]);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ventas_${businessId}_${from}_${to}.csv"`
    );

    // BOM UTF-8
    res.write('\uFEFF');

    const headers = [
      'business_id',
      'fecha',
      'article_id',
      'articulo_codigo',
      'articulo_nombre',
      'qty',
      'amount',
    ];
    res.write(headers.join(';') + '\n');

    for (const r of rows) {
      const line = [
        csvEscape(r.business_id),
        csvEscape(r.fecha?.toISOString?.().slice(0, 10) || r.fecha),
        csvEscape(r.article_id),
        csvEscape(r.articulo_codigo || ''),
        csvEscape(r.articulo_nombre || ''),
        csvEscape(r.qty || 0),
        csvEscape(r.amount || 0),
      ].join(';');
      res.write(line + '\n');
    }

    res.end();
  } catch (e) {
    console.error('[salesExportController] error exportando CSV', e);
    res.status(500).json({ error: 'Error exportando CSV' });
  }
};
