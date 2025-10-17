const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { runDailyAuto } = require('../services/salesSyncPolicy');

// Middlewares (opcional según flag)
const { authRequired } = require('../middleware/authMiddleware');
const requireAppAdmin = require('../middleware/requireAppAdmin');

function isCronAllowed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.get('X-Cron-Secret') === secret;
}

async function handleDailySync(req, res) {
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

// Exigir admin por flag
if (process.env.CRON_REQUIRE_ADMIN === '1') {
  router.post('/cron/sync-sales-daily', authRequired, requireAppAdmin, handleDailySync);
} else {
  router.post('/cron/sync-sales-daily', handleDailySync);
}

module.exports = router;
