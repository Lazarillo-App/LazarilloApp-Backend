// routes/adminCronRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { runDailyAuto, ensureInitialBackfillOnce } = require('../services/salesSyncPolicy');

// Guard opcional por secreto
function isCronAllowed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.get('X-Cron-Secret') === secret;
}

router.get('/ping', (req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

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
});

// (Opcional) endpoint para backfill inicial masivo
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
      const data = await ensureInitialBackfillOnce({ businessId: b.id });
      details.push({ id: b.id, ok: true, detail: data });
    } catch (e) {
      details.push({ id: b.id, ok: false, error: e?.message });
    }
  }
  return res.json({ ok: true, details });
});

router.post('/sync-sales-daily', async (req, res) => {
  const runId = (await pool.query(
    `INSERT INTO cron_runs (job_name, details) VALUES ($1, $2) RETURNING id`,
    ['sync-sales-daily', JSON.stringify({ trigger: 'manual|render' })]
  )).rows[0].id;

  try {
    // ... tu código actual que arma rows/details ...
    await pool.query(
      `UPDATE cron_runs SET finished_at=now(), status='ok', details=$2 WHERE id=$1`,
      [runId, JSON.stringify({ ran: rows.length, ok, fail })]
    );
    return res.json({ ok: true, ran: rows.length, ok_count: ok, fail_count: fail, details });
  } catch (e) {
    await pool.query(
      `UPDATE cron_runs SET finished_at=now(), status='error', details=$2 WHERE id=$1`,
      [runId, JSON.stringify({ message: e.message })]
    );
    throw e;
  }
});

module.exports = router;
