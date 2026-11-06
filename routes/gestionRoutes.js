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
const carga = require('../services/gestion/carga-api');
const pagos = require('../services/gestion/pagos-api');
const apertura = require('../services/gestion/apertura/api');
const empleados = require('../services/gestion/empleados/api');
const arca = require('../services/gestion/arca/api');
const actividad = require('../services/gestion/actividad-api');
const { db: gestionDb } = require('../services/gestion/db');

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
    if (e instanceof api.ErrorDatos) return res.status(e.status || 400).json({ error: e.message, ...e.extra });
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
router.get('/m/resumen', responder((req) =>
  api.obtenerResumenMes({ ...ambito(req), anio: entero(paramsDe(req), 'anio'), mes: entero(paramsDe(req), 'mes') })));
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
router.patch('/dashboard/pagos/:rowId', responder((req) =>
  detalle.editarPago({ ...req.gestion, rowId: req.params.rowId, body: req.body })));
router.patch('/dashboard/ventas/:rowId', responder((req) =>
  detalle.editarVenta({ ...req.gestion, rowId: req.params.rowId, body: req.body })));

// ── Sin carga, Impagas, pagos y cuenta corriente ──
const usuarioDe = (req) => req.user?.email ?? String(req.user?.id ?? '');
const idDe = (req) => Number(req.params.id);
router.get('/sin-carga', responder((req) => pagos.obtenerSinCarga(ambito(req))));
router.post('/sin-carga/descartes', responder((req) => pagos.crearDescarte({ ...ambito(req), usuario: usuarioDe(req), body: req.body })));
router.delete('/sin-carga/descartes/:id', responder((req) => pagos.borrarDescarte({ ...req.gestion, id: idDe(req) })));
router.get('/impagas', responder((req) => pagos.obtenerImpagas({ ...ambito(req), sp: paramsDe(req) })));
router.post('/impagas/forzadas', responder((req) => pagos.crearForzadas({ ...req.gestion, body: req.body })));
router.delete('/impagas/forzadas', responder((req) => pagos.borrarForzadas({ ...req.gestion, body: req.body })));
router.patch('/impagas/pago-automatico', responder((req) => pagos.cambiarPagoAutomatico({ ...req.gestion, body: req.body })));
router.get('/impagas/op-maxirest', responder((req) => pagos.obtenerOpMaxirest({ ...ambito(req), sp: paramsDe(req) })));
router.post('/impagas/pagos-internos', responder((req) => pagos.crearOp({ ...ambito(req), usuario: usuarioDe(req), body: req.body })));
router.get('/impagas/pagos-internos/historial', responder((req) => pagos.historialOp({ ...ambito(req), sp: paramsDe(req) })));
router.get('/impagas/pagos-internos/:id', responder((req) => pagos.obtenerOp({ ...req.gestion, id: idDe(req) })));
router.patch('/impagas/pagos-internos/:id', responder((req) => pagos.editarOp({ ...req.gestion, usuario: usuarioDe(req), id: idDe(req), body: req.body })));
router.delete('/impagas/pagos-internos/:id', responder((req) => pagos.anularOp({ ...req.gestion, usuario: usuarioDe(req), id: idDe(req) })));
router.post('/impagas/pagos-internos/:id/desimputar', responder((req) => pagos.desimputarOp({ ...req.gestion, usuario: usuarioDe(req), id: idDe(req), body: req.body })));
router.post('/pagos-proveedor', responder((req) => pagos.registrarPago({ ...req.gestion, usuario: usuarioDe(req), body: req.body })));
router.patch('/pagos-proveedor/:id', responder((req) => pagos.editarPago({ ...req.gestion, usuario: usuarioDe(req), id: idDe(req), body: req.body })));
router.delete('/pagos-proveedor/:id', responder((req) => pagos.anularPago({ ...req.gestion, usuario: usuarioDe(req), id: idDe(req) })));
router.delete('/pagos-proveedor/:id/aplicaciones', responder((req) => pagos.quitarAplicacion({ ...req.gestion, usuario: usuarioDe(req), id: idDe(req), sp: paramsDe(req) })));
// Lugares del negocio con la forma de gestion (un "local" con sus "puntos de venta").
router.get('/locales', responder(async (req) => {
  const lugares = await carga.obtenerLugares(gestionDb, req.gestion.businessId);
  return [{ id: req.gestion.businessId, nombre: req.business?.name ?? lugares[0]?.nombre ?? '', puntosDeVenta: lugares }];
}));
router.get('/cta-cte', responder((req) => pagos.obtenerCtaCte({ ...req.gestion, sp: paramsDe(req) })));
router.get('/cta-cte/proveedores', responder((req) => pagos.buscarProveedoresCtaCte({ ...req.gestion, sp: paramsDe(req) })));

// ── ARCA, actividad y notas ──
router.post('/arca/importar', responder((req) => arca.importarArca({ ...req.gestion, usuario: usuarioDe(req), body: req.body })));
router.get('/arca/cruce', responder((req) => arca.cruceArca(req.gestion)));
router.post('/arca/corregir', responder((req) => arca.corregirArca({ ...req.gestion, usuario: usuarioDe(req), body: req.body })));
router.get('/actividad', responder((req) => actividad.listarActividad({ ...req.gestion, usuario: usuarioDe(req), sp: paramsDe(req) })));
router.post('/actividad/:id/restaurar', responder((req) => actividad.restaurarFacturaEliminada({ ...req.gestion, usuario: usuarioDe(req), id: idDe(req) })));
router.get('/notas', responder((req) => actividad.leerNota({ ...req.gestion, userId: req.user?.id })));
router.put('/notas', responder((req) => actividad.guardarNota({ ...req.gestion, userId: req.user?.id, body: req.body })));

// ── Empleados y concepto fijo ──
router.get('/empleados', responder((req) => empleados.obtenerNomina({ ...req.gestion, sp: paramsDe(req) })));
router.post('/empleados', responder((req) => empleados.crearCarga({ ...req.gestion, usuario: usuarioDe(req), body: req.body })));
router.get('/empleados/cuenta', responder((req) => empleados.obtenerCuenta({ ...req.gestion, sp: paramsDe(req) })));
router.delete('/empleados/:id', responder((req) => empleados.anularCarga({ ...req.gestion, usuario: usuarioDe(req), id: idDe(req) })));
router.get('/conceptos-empleado', responder((req) => empleados.listarConceptosFijos({ ...req.gestion, sp: paramsDe(req) })));
router.post('/conceptos-empleado', responder((req) => empleados.guardarConceptoFijo({ ...req.gestion, usuario: usuarioDe(req), body: req.body })));
router.delete('/conceptos-empleado', responder((req) => empleados.quitarConceptoFijo({ ...req.gestion, sp: paramsDe(req) })));

// ── Apertura de gastos ──
const conUsuarioId = (req) => ({ ...req.gestion, userId: req.user?.id, usuario: usuarioDe(req) });
router.get('/apertura/locales', responder((req) => apertura.obtenerLocalesApertura(conUsuarioId(req))));
router.get('/apertura/reglas', responder((req) => apertura.listarReglas(req.gestion)));
router.get('/apertura/reglas/preview-total', responder((req) => apertura.previewTotal({ ...conUsuarioId(req), sp: paramsDe(req) })));
router.post('/apertura/reglas', responder((req) => apertura.crearRegla({ ...conUsuarioId(req), body: req.body })));
router.patch('/apertura/reglas/:id', responder((req) => apertura.editarRegla({ ...conUsuarioId(req), id: idDe(req), body: req.body })));
router.delete('/apertura/reglas/:id', responder((req) => apertura.borrarRegla({ ...conUsuarioId(req), id: idDe(req) })));

// ── Carga manual: facturas, gastos varios, ventas, conceptos y medios de pago ──
const conUsuario = (req) => ({ ...req.gestion, usuario: req.user?.email ?? String(req.user?.id ?? '') });
router.get('/facturas/maestros', responder((req) => carga.obtenerMaestrosFactura(req.gestion)));
router.post('/facturas/envases', responder((req) => carga.guardarEnvase({ ...req.gestion, body: req.body })));
router.delete('/facturas/envases', responder((req) => carga.borrarEnvase({ ...req.gestion, sp: paramsDe(req) })));
router.post('/facturas/descuentos', responder((req) => carga.guardarDescuentos({ ...req.gestion, body: req.body })));
router.post('/facturas/proveedores', responder((req) => carga.crearProveedor({ ...req.gestion, body: req.body })));
router.get('/facturas/proveedores/:id', responder((req) => carga.obtenerProveedor({ ...req.gestion, id: idDe(req) })));
router.patch('/facturas/proveedores/:id', responder((req) => carga.editarProveedor({ ...req.gestion, id: idDe(req), body: req.body })));
router.get('/facturas/de-compra', responder((req) => carga.facturaDeCompra({ ...req.gestion, sp: paramsDe(req) })));
router.get('/facturas/buscar', responder((req) => carga.buscarFilaFactura({ ...req.gestion, sp: paramsDe(req) })));
router.get('/facturas/existe', responder((req) => carga.facturaExiste({ ...req.gestion, sp: paramsDe(req) })));
router.get('/facturas/ultima', responder((req) => carga.ultimaFactura({ ...req.gestion, sp: paramsDe(req) })));
router.post('/facturas', responder((req) => carga.crearFactura({ ...conUsuario(req), body: req.body })));
router.get('/facturas/:rowId', responder((req) => carga.obtenerFactura({ ...req.gestion, rowId: req.params.rowId })));
router.put('/facturas/:rowId', responder((req) => carga.editarFactura({ ...conUsuario(req), rowId: req.params.rowId, body: req.body })));
router.delete('/facturas/:rowId', responder((req) =>
  carga.borrarFactura({ ...conUsuario(req), rowId: req.params.rowId, conPagos: paramsDe(req).get('conPagos') === '1' })));
router.get('/gastos-varios/historial', responder((req) => carga.historialConcepto({ ...req.gestion, sp: paramsDe(req) })));
router.post('/gastos-varios', responder((req) => carga.crearGastoVario({ ...conUsuario(req), body: req.body })));
router.get('/ventas-manuales', responder((req) => carga.obtenerVentasManuales(ambito(req))));
router.post('/ventas-manuales', responder((req) => carga.crearVentasManuales({ ...ambito(req), body: req.body })));
router.delete('/ventas-manuales', responder((req) => carga.borrarVentasManuales({ ...req.gestion, ids: paramsDe(req).get('ids') })));
router.get('/conceptos', responder((req) => carga.obtenerConceptos(req.gestion)));
router.post('/conceptos', responder((req) => carga.crearConcepto({ ...req.gestion, body: req.body })));
router.patch('/conceptos/:codigo', responder((req) => carga.editarConcepto({ ...req.gestion, codigo: req.params.codigo, body: req.body })));
router.delete('/conceptos/:codigo', responder((req) => carga.borrarConcepto({ ...req.gestion, codigo: req.params.codigo })));
router.get('/medios-pago', responder((req) => carga.obtenerMedios(req.gestion)));
router.post('/medios-pago', responder((req) => carga.crearMedio({ ...req.gestion, body: req.body })));
router.put('/medios-pago/:id', responder((req) => carga.editarMedio({ ...req.gestion, id: Number(req.params.id), body: req.body })));
router.delete('/medios-pago/:id', responder((req) => carga.borrarMedio({ ...req.gestion, id: Number(req.params.id) })));

module.exports = router;
