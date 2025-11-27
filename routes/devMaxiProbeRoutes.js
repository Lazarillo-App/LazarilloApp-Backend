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
    const to = String(req.query.to || '').slice(0, 10);

    if (!Number.isFinite(businessId) || !from || !to) {
      return res.status(400).json({ error: 'bad_request', hint: 'use ?biz=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD' });
    }

    const bearer = await getBearer(businessId, req);
    const payload = await fetchInvoiceByDate(from, to, bearer);

    // Normalizamos facturas igual que el extractor
    let facturasArr = [];

    if (Array.isArray(payload)) {
      facturasArr = payload;
    } else if (Array.isArray(payload?.facturas)) {
      facturasArr = payload.facturas;
    } else if (Array.isArray(payload?.content?.facturas)) {
      facturasArr = payload.content.facturas;
    } else if (Array.isArray(payload?.content?.content?.facturas)) {
      facturasArr = payload.content.content.facturas;
    } else if (payload?.facturas && typeof payload.facturas === 'object') {
      // 🆕 facturas como objeto con arrays
      const nested = Object.values(payload.facturas)
        .filter((v) => Array.isArray(v) && v.length > 0);
      if (nested.length) facturasArr = nested.flat();
    }

    const count = Array.isArray(facturasArr) ? facturasArr.length : 0;

    res.json({
      ok: true,
      business_id: businessId,
      from,
      to,
      maxi_count: count,
      cantidad_campo: payload?.cantidad ?? null,
      tipo_facturas: payload?.facturas ? typeof payload.facturas : null,
      tiene_facturas_array: Array.isArray(payload?.facturas),
      preview_keys: Object.keys(payload || {}).slice(0, 20),
      // opcional: primera factura para ver la forma (recortá si te molesta)
      sample_factura: Array.isArray(facturasArr) && facturasArr.length ? facturasArr[0] : null,
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
