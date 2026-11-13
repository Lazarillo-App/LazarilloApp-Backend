// routes/conciliacionRoutes.js
// Módulo de conciliación bancaria (14/11/2026). Se monta bajo
// /api/businesses/:businessId/conciliacion. El guard global de /api (authRequired +
// loadActiveBusiness) corre antes. Solo owner y admin: es todo plata (el staff no ve montos).
const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireBusinessRole } = require('../middleware/authMiddleware');
const svc = require('../services/conciliacionService');

router.use(requireBusinessRole('admin'));
router.use((req, res, next) => {
  if (Number(req.params.businessId) !== Number(req.businessId)) {
    return res.status(403).json({ error: 'business_mismatch' });
  }
  next();
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

router.get('/', manejar((req) => svc.cargar(bid(req))));

router.put('/fuentes/:tipo', manejar(async (req) => {
  const v = svc.validarFuente(req.params.tipo, req.body);
  if (v.error) return v;
  return svc.guardarFuente(bid(req), req.user?.id, v.fila);
}));

router.delete('/fuentes/:tipo', manejar((req) => svc.borrarFuente(bid(req), req.params.tipo)));

router.get('/estado', manejar(async (req) => {
  const periodo = svc.validarPeriodo(String(req.query.periodo || ''));
  if (!periodo) return { error: 'periodo_invalido' };
  return svc.leerEstado(bid(req), periodo);
}));

router.put('/estado', manejar(async (req) => {
  const periodo = svc.validarPeriodo(String(req.body?.periodo || ''));
  if (!periodo) return { error: 'periodo_invalido' };
  const estado = req.body?.estado;
  if (!estado || typeof estado !== 'object' || Array.isArray(estado)) return { error: 'estado_invalido' };
  return svc.guardarEstado(bid(req), req.user?.id, periodo, estado);
}));

router.put('/pagadores', manejar(async (req) => {
  const mapa = req.body?.mapa;
  if (!mapa || typeof mapa !== 'object' || Array.isArray(mapa)) return { error: 'mapa_invalido' };
  return svc.guardarPagadores(bid(req), mapa);
}));

module.exports = router;
