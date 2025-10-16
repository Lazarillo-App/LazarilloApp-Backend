// routes/adminCronRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { runDailyAuto } = require('../services/salesSyncPolicy');

// --- Protecciones opcionales ---
const { authRequired } = require('../middleware/authMiddleware') || {};
const requireAdmin = (req, res, next) =>
  req.user?.role === 'app_admin' ? next() : res.status(403).json({ error: 'forbidden' });

function isCronAllowed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // si no hay secreto, no filtramos por header
  return req.get('X-Cron-Secret') === secret;
}

// Handler principal del cron
async function handleDailySync(req, res) {
  if (!isCronAllowed(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { rows } = await pool.query(`
    SELECT id
    FROM app_businesses
    WHERE (props->'maxi'->>'email') IS NOT NULL
      AND (props->'maxi'->>'codcli') IS NOT NULL
      AND (props->'maxi' ? 'pass_enc' OR props->'maxi' ? 'pass' OR props->'maxi' ? 'password')
  `);

  const details = [];
  let ok = 0, fail = 0;

  for (const b of rows) {
    try {
      const data = await runDailyAuto({ businessId: b.id });
      details.push({ id: b.id, ok: true, detail: data });
      ok++;
    } catch (e) {
      details.push({ id: b.id, ok: false, error: e?.message });
      fail++;
    }
  }

  return res.json({ ok: true, ran: rows.length, ok_count: ok, fail_count: fail, details });
}

// Montaje de la ruta, con o sin JWT admin según env
if (process.env.CRON_REQUIRE_ADMIN === '1' && authRequired) {
  router.post('/cron/sync-sales-daily', authRequired, requireAdmin, handleDailySync);
} else {
  router.post('/cron/sync-sales-daily', handleDailySync);
}

module.exports = router;
