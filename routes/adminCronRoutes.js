// routes/adminCronRoutes.js (protegida con una API key simple por header)
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { syncSalesForBusiness } = require('../controllers/salesSyncController');

router.post('/cron/sync-sales-daily', async (req, res) => {
  if (req.get('X-Cron-Secret') !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { rows } = await pool.query(`
    SELECT id, props
    FROM app_businesses
    WHERE (props->'maxi'->>'email') IS NOT NULL
      AND (props->'maxi'->>'codcli') IS NOT NULL
      AND (props->'maxi' ? 'pass_enc' OR props->'maxi' ? 'pass' OR props->'maxi' ? 'password')
  `);

  const out = [];
  for (const b of rows) {
    try {
      const data = await syncSalesForBusiness({ id: b.id }, { mode: 'auto' });
      out.push({ id: b.id, ok: true, counts: data?.counts, range: data?.range });
    } catch (e) {
      out.push({ id: b.id, ok: false, error: e?.message });
    }
  }
  res.json({ ok: true, ran: out.length, details: out });
});

module.exports = router;
