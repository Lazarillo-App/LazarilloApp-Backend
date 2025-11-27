// routes/adminCronRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { runDailyAuto, ensureInitialBackfillOnce } = require('../services/salesSyncPolicy');

function isCronAllowed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.get('X-Cron-Secret') === secret;
}

// POST /api/cron/sync-sales-daily   (sin JWT, con X-Cron-Secret)
router.post('/sync-sales-daily', async (req, res) => {
  if (!isCronAllowed(req)) return res.status(401).json({ error: 'unauthorized' });

  const { rows } = await pool.query(`
    SELECT id
    FROM app_businesses
    WHERE (props->'maxi'->>'email') IS NOT NULL
      AND (props->'maxi'->>'codcli') IS NOT NULL
      AND (props->'maxi' ? 'pass_enc' OR props->'maxi' ? 'pass' OR props->'maxi' ? 'password')
  `);

  const details = [];
  let ok = 0, fail = 0;

  // Ejecutamos en serie para evitar colisiones de lock innecesarias
  for (const b of rows) {
    try {
      const data = await runDailyAuto({ businessId: b.id });
      details.push({ id: String(b.id), ok: true, detail: data });
      ok++;
    } catch (e) {
      details.push({ id: String(b.id), ok: false, error: e?.message });
      fail++;
    }
  }
  return res.json({ ok: true, ran: rows.length, ok_count: ok, fail_count: fail, details });
});

// POST /api/cron/backfill-30d  (si querés forzar 30d en masa)
// Usa ensureInitialBackfillOnce con windowDays=30
router.post('/backfill-30d', async (req, res) => {
  if (!isCronAllowed(req)) return res.status(401).json({ error: 'unauthorized' });

  const { rows } = await pool.query(`
    SELECT id
    FROM app_businesses
    WHERE (props->'maxi'->>'email') IS NOT NULL
      AND (props->'maxi'->>'codcli') IS NOT NULL
      AND (props->'maxi' ? 'pass_enc' OR props->'maxi' ? 'pass' OR props->'maxi' ? 'password')
  `);

  const details = [];
  for (const b of rows) {
    try {
      const data = await ensureInitialBackfillOnce({ businessId: b.id, windowDays: 30 });
      details.push({ id: String(b.id), ok: true, detail: data });
    } catch (e) {
      details.push({ id: String(b.id), ok: false, error: e?.message });
    }
  }
  return res.json({ ok: true, details });
});

// POST /api/cron/backfill-7d  → forzar backfill de últimos 7 días para TODOS
router.post('/backfill-7d', async (req, res) => {
  if (!isCronAllowed(req)) return res.status(401).json({ error: 'unauthorized' });

  const { rows } = await pool.query(`
    SELECT id
    FROM app_businesses
    WHERE (props->'maxi'->>'email') IS NOT NULL
      AND (props->'maxi'->>'codcli') IS NOT NULL
      AND (props->'maxi' ? 'pass_enc' OR props->'maxi' ? 'pass' OR props->'maxi' ? 'password')
  `);

  const details = [];
  for (const b of rows) {
    try {
      // 🔹 forzamos windowDays = 7 para todos los negocios
      const data = await ensureInitialBackfillOnce({
        businessId: b.id,
        windowDays: 7,
      });
      details.push({ id: String(b.id), ok: true, detail: data });
    } catch (e) {
      details.push({ id: String(b.id), ok: false, error: e?.message });
    }
  }

  return res.json({ ok: true, details });
});

// POST /api/cron/sync-one/:businessId  → útil para probar un negocio puntual
router.post('/sync-one/:businessId', async (req, res) => {
  if (!isCronAllowed(req)) return res.status(401).json({ error: 'unauthorized' });
  const businessId = Number(req.params.businessId);
  if (!Number.isFinite(businessId)) return res.status(400).json({ error: 'invalid_business_id' });

  try {
    const detail = await runDailyAuto({ businessId, req });
    return res.json({ ok: true, business_id: businessId, detail });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message });
  }
});

module.exports = router;
