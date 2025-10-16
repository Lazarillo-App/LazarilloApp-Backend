// routes/adminCronRoutes.js (protegida con una API key simple por header)
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { runDailyAuto } = require('../services/salesSyncPolicy');

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
            const data = await runDailyAuto({ businessId: b.id });
            out.push({ id: b.id, ok: true, detail: data });
        } catch (e) {
            out.push({ id: b.id, ok: false, error: e?.message });
        }
    }
    res.json({ ok: true, ran: out.length, details: out });
});

module.exports = router;
