// routes/adminCronRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');

const {
  runDailyAuto,
  ensureInitialBackfillOnce,      // compat 30d
  resyncRollingWindow            // re-sella N días (p.ej. 7)
} = require('../services/salesSyncPolicy');

// Guard opcional por secreto (sin JWT)
function isCronAllowed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.get('X-Cron-Secret') === secret;
}

/**
 * POST /api/cron/sync-sales-daily
 * Incremental diario “ayer” para todos los negocios con credenciales Maxi válidas.
 * Header: X-Cron-Secret: <secret>
 */
router.post('/sync-sales-daily', async (req, res) => {
  if (!isCronAllowed(req)) return res.status(401).json({ error: 'unauthorized' });

  const { rows } = await pool.query(`
    SELECT id
    FROM app_businesses
    WHERE (props->'maxi'->>'email')  IS NOT NULL
      AND (props->'maxi'->>'codcli') IS NOT NULL
      AND (props->'maxi' ? 'pass_enc' OR props->'maxi' ? 'pass' OR props->'maxi' ? 'password')
  `);

  const details = [];
  let ok = 0, fail = 0;

  for (const b of rows) {
    try {
      // Pasamos req para respetar X-Maxi-Token si lo hubiera
      const data = await runDailyAuto({ businessId: b.id, req });
      details.push({ id: String(b.id), ok: true, detail: data });
      ok++;
    } catch (e) {
      details.push({ id: String(b.id), ok: false, error: e?.message });
      fail++;
    }
  }

  return res.json({ ok: true, ran: rows.length, ok_count: ok, fail_count: fail, details });
});

/**
 * POST /api/cron/backfill-30d
 * Compat: corre el backfill de 30 días (solo donde no esté marcado como hecho).
 * Header: X-Cron-Secret: <secret>
 */
router.post('/backfill-30d', async (req, res) => {
  if (!isCronAllowed(req)) return res.status(401).json({ error: 'unauthorized' });

  const { rows } = await pool.query(`
    SELECT id
    FROM app_businesses
    WHERE (props->'maxi'->>'email')  IS NOT NULL
      AND (props->'maxi'->>'codcli') IS NOT NULL
      AND (props->'maxi' ? 'pass_enc' OR props->'maxi' ? 'pass' OR props->'maxi' ? 'password')
  `);

  const details = [];
  for (const b of rows) {
    try {
      const data = await ensureInitialBackfillOnce({ businessId: b.id, req });
      details.push({ id: String(b.id), ok: true, detail: data });
    } catch (e) {
      details.push({ id: String(b.id), ok: false, error: e?.message });
    }
  }
  return res.json({ ok: true, details });
});

/**
 * OPCIONAL: POST /api/cron/seed-week
 * Re-sella una ventana de N días (default 7, hasta AYER) para un negocio puntual.
 * Header: X-Cron-Secret: <secret>
 * Body: { "biz": 31, "days": 7 }
 */
router.post('/seed-week', async (req, res) => {
  if (!isCronAllowed(req)) return res.status(401).json({ error: 'unauthorized' });
  const biz  = Number(req.body?.biz || req.query?.biz);
  const days = Number(req.body?.days || req.query?.days || 7);
  if (!Number.isFinite(biz)) return res.status(400).json({ error: 'biz requerido' });

  try {
    const data = await resyncRollingWindow({ businessId: biz, days, req });
    return res.json({ ok: true, business_id: biz, window_days: days, detail: data });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e?.message || 'internal' });
  }
});

module.exports = router;
