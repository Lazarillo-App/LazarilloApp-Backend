// routes/gestionRoutes.js
// API del Panel de gestion (port de lazarillo_gestion, services/gestion/dashboard).
//
// Se monta bajo /api/businesses/:businessId/gestion en app.js. El guard global de /api
// (authRequired + loadActiveBusiness) corre antes y deja req.businessId / req.businessRole.
// Solo owner y admin del negocio (decisión de la usuaria, 2026-10-30).
const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireBusinessRole } = require('../middleware/authMiddleware');
const { parseDashboardParams } = require('../services/gestion/dashboard/params');
const { obtenerPivot } = require('../services/gestion/dashboard/pivot');

router.use(requireBusinessRole('admin'));

// El negocio de la URL tiene que ser el que validó el guard (que lo toma del header
// X-Business-Id o del negocio activo): si difieren, se estarían pidiendo datos de un
// negocio con los permisos de otro.
router.use((req, res, next) => {
  if (Number(req.params.businessId) !== Number(req.businessId)) {
    return res.status(403).json({ error: 'business_mismatch' });
  }
  // Los maestros de gestion (conceptos, rubros, proveedores) son de la organización.
  const organizationId = Number(req.business?.organization_id);
  if (!Number.isFinite(organizationId) || organizationId <= 0) {
    return res.status(409).json({ error: 'business_sin_organizacion', message: 'El Panel necesita que el negocio pertenezca a una organización.' });
  }
  req.gestion = { organizationId, businessId: Number(req.businessId) };
  next();
});

// Query string tal como lo arma el front (mismos parámetros que la API de gestion).
const paramsDe = (req) => new URL(req.originalUrl, 'http://local').searchParams;

// Pivot de Compras (por concepto / proveedor / insumo; económica o financiera).
router.get('/dashboard/pivot', async (req, res, next) => {
  try {
    const data = await obtenerPivot({ ...req.gestion, params: parseDashboardParams(paramsDe(req)) });
    res.json(data);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
