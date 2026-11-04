// routes/gestionRoutes.js
// API del Panel de gestion (port de lazarillo_gestion, services/gestion/dashboard).
//
// Se monta bajo /api/businesses/:businessId/gestion en app.js. El guard global de /api
// (authRequired + loadActiveBusiness) corre antes y deja req.businessId / req.businessRole.
// Solo owner y admin del negocio (decisión de la usuaria, 2026-10-30).
const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireBusinessRole } = require('../middleware/authMiddleware');
const { parseDashboardParams, parseVentasParams, parseSucursal } = require('../services/gestion/dashboard/params');
const { obtenerPivot } = require('../services/gestion/dashboard/pivot');
const { obtenerPivotVentas } = require('../services/gestion/dashboard/pivot-ventas');
const api = require('../services/gestion/dashboard/resultados-api');
const busqueda = require('../services/gestion/dashboard/busqueda-api');
const detalle = require('../services/gestion/dashboard/detalle-api');

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

// Pivot de Ventas (tipo → forma de cobro, por mes).
router.get('/dashboard/pivot-ventas', async (req, res, next) => {
  try {
    const data = await obtenerPivotVentas({ businessId: req.gestion.businessId, params: parseVentasParams(paramsDe(req)) });
    res.json(data);
  } catch (e) {
    next(e);
  }
});

// ── Resultados, tarjetas KPI y bloque Operación (paso 3) ──────────────────────
// Enteros positivos del query string (en gestion: n(k)); undefined si falta o es inválido.
const entero = (sp, k) => { const v = Number(sp.get(k)); return Number.isInteger(v) && v > 0 ? v : undefined; };
// ?sucursal y lo del negocio, para los endpoints que solo filtran por sucursal.
const ambito = (req) => ({ ...req.gestion, sucursal: parseSucursal(paramsDe(req)) });

// Envuelve un handler: los datos inválidos responden 400 con su mensaje (como en gestion).
const responder = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    if (e instanceof api.ErrorDatos) return res.status(e.status || 400).json({ error: e.message });
    next(e);
  }
};

router.get('/dashboard/proyeccion', responder((req) =>
  api.obtenerProyeccion({ businessId: req.gestion.businessId, params: parseVentasParams(paramsDe(req)) })));
router.get('/dashboard/equilibrio', responder((req) =>
  api.obtenerEquilibrio({ ...ambito(req), year: entero(paramsDe(req), 'year') })));
router.get('/dashboard/equilibrio/variables', responder((req) =>
  api.obtenerEquilibrioVariables({ ...ambito(req), anio: entero(paramsDe(req), 'anio'), mes: entero(paramsDe(req), 'mes') })));
router.put('/dashboard/equilibrio/variables', responder((req) =>
  api.guardarEquilibrioVariables({ ...req.gestion, body: req.body })));
router.get('/dashboard/flujo-caja', responder((req) =>
  api.obtenerFlujoCaja({ ...ambito(req), anio: Number.parseInt(paramsDe(req).get('anio'), 10) })));
router.put('/dashboard/flujo-caja', responder((req) =>
  api.guardarFlujoCaja({ ...ambito(req), body: req.body })));
router.get('/dashboard/diferencia-caja', responder((req) =>
  api.obtenerDiferenciaCaja({ ...ambito(req), year: Number.parseInt(paramsDe(req).get('year'), 10) })));
router.get('/dashboard/canasta', responder((req) =>
  api.obtenerCanasta({ ...ambito(req), anio: entero(paramsDe(req), 'anio'), mes: entero(paramsDe(req), 'mes') })));
router.post('/dashboard/canasta/aumentos', responder((req) =>
  api.anotarAumento({ ...ambito(req), body: req.body })));
router.delete('/dashboard/canasta/aumentos', responder((req) =>
  api.borrarAumento({ ...ambito(req), body: req.body })));
router.get('/m/anual', responder((req) =>
  api.obtenerAnual({ ...ambito(req), anio: entero(paramsDe(req), 'anio') })));
router.get('/dashboard/actualizado', responder((req) => api.obtenerActualizado(ambito(req))));
router.get('/dashboard/rango-anios', responder((req) => api.obtenerRangoAnios(ambito(req))));

// ── Buscador (⌘K) y rubros visibles ────────────────────────────────────────────
router.get('/search/suggestions', responder((req) =>
  busqueda.obtenerSugerencias({ ...ambito(req), q: paramsDe(req).get('q') })));
router.get('/search/observaciones', responder((req) =>
  busqueda.obtenerObservaciones({ ...req.gestion, q: paramsDe(req).get('q') })));
router.get('/search/importe', responder((req) =>
  busqueda.obtenerImportes({ ...req.gestion, q: paramsDe(req).get('q') })));
router.get('/config/rubros-dashboard', responder((req) =>
  busqueda.obtenerRubrosVisibles({ ...req.gestion, field: paramsDe(req).get('field') })));
router.patch('/config/rubros-dashboard', responder((req) =>
  busqueda.guardarRubroVisible({ ...req.gestion, body: req.body })));

// ── Detalle y edición (click en una celda del Panel) ──────────────────────────
router.get('/config/conceptos', responder((req) => detalle.obtenerConceptosEdicion(req.gestion)));
router.get('/dashboard/detalle', responder((req) =>
  detalle.obtenerDetalleCompras({ ...ambito(req), sp: paramsDe(req) })));
router.get('/dashboard/detalle-ventas', responder((req) =>
  detalle.obtenerDetalleVentas({ ...ambito(req), sp: paramsDe(req) })));
router.get('/dashboard/compra-lineas/:compraId', responder((req) =>
  detalle.obtenerCompraLineas({ ...req.gestion, compraId: req.params.compraId })));
router.patch('/dashboard/compras/:rowId', responder((req) =>
  detalle.editarCompra({ ...req.gestion, rowId: req.params.rowId, body: req.body })));
router.patch('/dashboard/ventas/:rowId', responder((req) =>
  detalle.editarVenta({ ...req.gestion, rowId: req.params.rowId, body: req.body })));

module.exports = router;
