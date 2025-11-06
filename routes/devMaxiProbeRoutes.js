// routes/devMaxiProbeRoutes.js
const express = require('express');
const router = express.Router();
const { getBearer, fetchFullByDate } = require('../services/maxiSalesService');
const { addDaysUTC } = require('../services/maxiSalesService'); // si no exportás, reemplazá con util local

// GET /api/dev/maxi-probe?biz=31&from=2025-10-23&to=2025-11-05
router.get('/maxi-probe', async (req,res) => {
  try {
    const businessId = Number(req.query.biz);
    const from = String(req.query.from||'').slice(0,10);
    const to   = String(req.query.to||'').slice(0,10);
    if (!businessId || !from || !to) return res.status(400).json({ error: 'biz/from/to requeridos' });

    const bearer = await getBearer(businessId, req);
    const payload = await fetchFullByDate(from, to, bearer);
    const count =
      Array.isArray(payload) ? payload.length :
      Array.isArray(payload?.facturas) ? payload.facturas.length :
      Array.isArray(payload?.content?.facturas) ? payload.content.facturas.length :
      Array.isArray(payload?.content?.content?.facturas) ? payload.content.content.facturas.length :
      0;

    res.json({ ok:true, business_id: businessId, from, to, maxi_count: count, preview: String(Object.keys(payload||{})).slice(0,120) });
  } catch (e) {
    res.status(e.status||500).json({ error:'probe_failed', message: e?.message, info: e?._maxi });
  }
});

module.exports = router;
