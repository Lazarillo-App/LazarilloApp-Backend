// routes/devMaxiProbeRoutes.js
const express = require('express');
const router = express.Router();

const { authRequired } = require('../middleware/authMiddleware');
const { getBearer, fetchInvoiceByDate } = require('../services/maxiSalesService');

// Requiere Authorization: Bearer <TOKEN_APP>
router.use(authRequired);

/**
 * GET /api/dev/maxi-probe?biz=31&from=2025-10-13&to=2025-10-19
 * - Usa las credenciales Maxi del negocio (o X-Maxi-Token si viene)
 * - Llama al endpoint de Maxi /estadisticas/invoicebydate (7d máx por ventana)
 * - Devuelve conteo rápido y una preview del payload
 */
router.get('/maxi-probe', async (req, res) => {
  try {
    const businessId = Number(req.query.biz);
    const from = String(req.query.from || '').slice(0, 10);
    const to   = String(req.query.to   || '').slice(0, 10);

    if (!Number.isFinite(businessId) || !from || !to) {
      return res.status(400).json({ error: 'bad_request', hint: 'use ?biz=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD' });
    }

    const bearer = await getBearer(businessId, req);
    const payload = await fetchInvoiceByDate(from, to, bearer);

    const count =
      Array.isArray(payload) ? payload.length :
      Array.isArray(payload?.facturas) ? payload.facturas.length :
      Array.isArray(payload?.content?.facturas) ? payload.content.facturas.length :
      Array.isArray(payload?.content?.content?.facturas) ? payload.content.content.facturas.length :
      0;

    res.json({
      ok: true,
      business_id: businessId,
      from,
      to,
      maxi_count: count,
      // preview muy básica para diagnosticar el "shape" sin devolver todo
      preview_keys: Object.keys(payload || {}).slice(0, 20)
    });
  } catch (e) {
    res.status(e.status || 500).json({
      error: 'probe_failed',
      message: e?.message,
      info: e?._maxi || null
    });
  }
});

module.exports = router;
