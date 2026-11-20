// routes/conciliacionRoutes.js
// Módulo de conciliación bancaria (14/11/2026). Se monta bajo
// /api/businesses/:businessId/conciliacion. El guard global de /api (authRequired +
// loadActiveBusiness) corre antes. Solo owner y admin: es todo plata (el staff no ve montos).
// Todo va por sucursal: ?sucursal= (0 o vacío = la principal; si no, una sucursal del negocio).
const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireBusinessRole } = require('../middleware/authMiddleware');
const svc = require('../services/conciliacionService');
const maxi = require('../services/conciliacionMaxiService');

router.use(requireBusinessRole('admin'));
router.use(async (req, res, next) => {
  if (Number(req.params.businessId) !== Number(req.businessId)) {
    return res.status(403).json({ error: 'business_mismatch' });
  }
  try {
    const s = await svc.validarSucursal(Number(req.businessId), req.query.sucursal);
    if (s === null) return res.status(400).json({ error: 'sucursal_invalida' });
    req.sucursal = s;
    next();
  } catch (e) {
    next(e);
  }
});

const bid = (req) => Number(req.businessId);
const manejar = (fn) => async (req, res) => {
  try {
    const r = await fn(req);
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    console.error('[conciliacion]', e);
    res.status(500).json({ error: 'conciliacion_error' });
  }
};

router.get('/', manejar((req) => svc.cargar(bid(req), req.sucursal)));

router.put('/fuentes/:tipo', manejar(async (req) => {
  const v = svc.validarFuente(req.params.tipo, req.body);
  if (v.error) return v;
  return svc.guardarFuente(bid(req), req.sucursal, req.user?.id, v.fila);
}));

router.delete('/fuentes/:tipo', manejar((req) => svc.borrarFuente(bid(req), req.sucursal, req.params.tipo)));

router.get('/estado', manejar(async (req) => {
  const periodo = svc.validarPeriodo(String(req.query.periodo || ''));
  if (!periodo) return { error: 'periodo_invalido' };
  return svc.leerEstado(bid(req), req.sucursal, periodo);
}));

router.put('/estado', manejar(async (req) => {
  const periodo = svc.validarPeriodo(String(req.body?.periodo || ''));
  if (!periodo) return { error: 'periodo_invalido' };
  const estado = req.body?.estado;
  if (!estado || typeof estado !== 'object' || Array.isArray(estado)) return { error: 'estado_invalido' };
  return svc.guardarEstado(bid(req), req.sucursal, req.user?.id, periodo, estado);
}));

// Ventas y cobranzas de cuenta corriente desde las tablas de MaxiRest en Render (sin subir Excel).
router.get('/maxi', manejar((req) => (req.query.desde
  ? maxi.traer(bid(req), req.sucursal, String(req.query.desde), String(req.query.hasta || ''))
  : maxi.estado(bid(req), req.sucursal))));

router.put('/pagadores', manejar(async (req) => {
  const mapa = req.body?.mapa;
  if (!mapa || typeof mapa !== 'object' || Array.isArray(mapa)) return { error: 'mapa_invalido' };
  return svc.guardarPagadores(bid(req), req.sucursal, mapa);
}));

// Mandar registros a otro PDV (Diego 20/11/2026: «lo tildo y aprieto el PDV donde lo quiero mandar»).
// body: { hacia: sucursal destino, items: [{ tipo: 'ventas'|'banco'|'pagos', clave, fila }] }
router.post('/traslados', manejar(async (req) => {
  const hacia = await svc.validarSucursal(bid(req), req.body?.hacia);
  if (hacia === null) return { error: 'sucursal_destino_invalida' };
  if (hacia === req.sucursal) return { error: 'misma_sucursal' };
  const v = svc.validarTraslado(req.body);
  if (v.error) return v;
  const r = await svc.trasladar(bid(req), req.sucursal, hacia, req.user?.id, v.items);
  const [de, a] = await Promise.all([svc.nombreSucursal(bid(req), req.sucursal), svc.nombreSucursal(bid(req), hacia)]);
  const n = v.items.length;
  const pesos = (x) => '$ ' + Math.round(x).toLocaleString('es-AR');
  require('../services/notificationService').avisarAbm(req, {
    businessId: bid(req), type: 'conciliacion_traslado',
    title: n === 1 ? `Conciliación: registro de ${pesos(r.total)} de ${de} a ${a}` : `Conciliación: ${n} registros (${pesos(r.total)}) de ${de} a ${a}`,
    message: r.devueltos ? `${r.devueltos} volvi${r.devueltos === 1 ? 'ó' : 'eron'} a su sucursal de origen.` : null,
    metadata: { link: '/conciliacion', desde: req.sucursal, hacia },
  });
  return { ...r, traslados: await svc.trasladosDe(bid(req), req.sucursal) };
}));

module.exports = router;
