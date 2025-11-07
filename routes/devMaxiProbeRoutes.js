// routes/devMaxiProbeRoutes.js
const express = require('express');
const router = express.Router();
const { getBearer, fetchInvoiceByDate } = require('../services/maxiSalesService');

/**
 * GET /api/dev/maxi-probe?biz=31&from=2025-10-23&to=2025-11-05[&raw=1]
 * - biz: businessId (required)
 * - from/to: YYYY-MM-DD (required)
 * - raw=1: devuelve payload crudo (cuidado: pesado)
 */
router.get('/maxi-probe', async (req, res) => {
  try {
    const businessId = Number(req.query.biz);
    const from = String(req.query.from || '').slice(0, 10);
    const to   = String(req.query.to   || '').slice(0, 10);
    const wantRaw = String(req.query.raw || '') === '1';

    if (!businessId || !from || !to) {
      return res.status(400).json({ error: 'biz/from/to requeridos' });
    }

    const bearer = await getBearer(businessId, req);
    const payload = await fetchInvoiceByDate(from, to, bearer);

    // Conteo robusto
    const count =
      Array.isArray(payload) ? payload.length :
      Array.isArray(payload?.facturas) ? payload.facturas.length :
      Array.isArray(payload?.content?.facturas) ? payload.content.facturas.length :
      Array.isArray(payload?.content?.content?.facturas) ? payload.content.content.facturas.length :
      Array.isArray(payload?.content) ? payload.content.length :
      0;

    if (wantRaw) {
      return res.json({ ok: true, business_id: businessId, from, to, maxi_count: count, payload });
    }

    return res.json({
      ok: true,
      business_id: businessId,
      from,
      to,
      maxi_count: count,
      keys_preview: Object.keys(payload || {}).slice(0, 10),
    });
  } catch (e) {
    return res
      .status(e.status || 500)
      .json({ error: 'probe_failed', message: e?.message, info: e?._maxi });
  }
});

module.exports = router;
