// routes/mercadolibreRoutes.js
// Mercado Libre (14/11/2026): conexión del negocio y sus compras, para cargarlas como factura en el
// Panel de Gestión. Se monta bajo /api/businesses/:businessId/mercadolibre; el guard global de /api
// corre antes. Solo owner y admin. Ver services/mercadolibreService.js.
const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireBusinessRole } = require('../middleware/authMiddleware');
const ml = require('../services/mercadolibreService');

router.use(requireBusinessRole('admin'));
router.use((req, res, next) => {
  if (Number(req.params.businessId) !== Number(req.businessId)) return res.status(403).json({ error: 'business_mismatch' });
  next();
});

const bid = (req) => Number(req.businessId);
const manejar = (fn) => async (req, res) => {
  try {
    const r = await fn(req);
    if (r && r.error) return res.status(r.error === 'ml_no_conectado' || r.error === 'no_encontrada' ? 404 : 400).json(r);
    res.json(r);
  } catch (e) {
    console.error('[mercadolibre]', e);
    res.status(500).json({ error: 'mercadolibre_error' });
  }
};

router.get('/estado', manejar((req) => ml.estado(bid(req))));
router.get('/autorizar', manejar(async (req) => {
  if (!ml.configurado()) return { error: 'ml_sin_configurar' };
  return { url: ml.urlAutorizacion(bid(req), req.user?.id) };
}));
router.post('/conectar', manejar((req) => ml.conectar(bid(req), req.user?.id, req.body?.code, req.body?.state)));
router.delete('/', manejar((req) => ml.desconectar(bid(req))));
router.post('/sincronizar', manejar((req) => ml.sincronizar(bid(req), req.body?.desde, req.body?.hasta)));
router.get('/compras', manejar((req) => ml.listar(bid(req))));
router.patch('/compras/:orderId', manejar((req) => ml.marcar(bid(req), req.params.orderId, req.body?.estado_carga, req.user?.id)));

module.exports = router;
