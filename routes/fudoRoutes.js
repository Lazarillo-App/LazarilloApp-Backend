// routes/fudoRoutes.js
// Fudo (17/11/2026): conexión del negocio por la API oficial, vínculo de productos con artículos y
// sincronización de ventas. Se monta bajo /api/businesses/:businessId/fudo; el guard global de /api
// corre antes. Solo owner y admin. Las claves entran y nunca vuelven a salir (estado no las devuelve).
// Ver services/fudoService.js.
const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireBusinessRole } = require('../middleware/authMiddleware');
const fudo = require('../services/fudoService');

router.use(requireBusinessRole('admin'));
router.use((req, res, next) => {
  if (Number(req.params.businessId) !== Number(req.businessId)) return res.status(403).json({ error: 'business_mismatch' });
  next();
});

const bid = (req) => Number(req.businessId);
const STATUS = { fudo_no_conectado: 404, fudo_en_curso: 409, fudo_vencido: 409 };
const manejar = (fn) => async (req, res) => {
  try {
    const r = await fn(req);
    if (r && r.error) return res.status(STATUS[r.error] || 400).json(r);
    res.json(r);
  } catch (e) {
    console.error('[fudo]', e.message);
    res.status(502).json({ error: 'fudo_error', message: 'No se pudo hablar con Fudo. Probá de nuevo en unos minutos.' });
  }
};

router.get('/estado', manejar((req) => fudo.estado(bid(req))));
router.post('/conectar', manejar((req) => fudo.conectar(bid(req), req.user?.id, {
  apiKey: req.body?.apiKey, apiSecret: req.body?.apiSecret, branchId: req.body?.branchId,
})));
router.delete('/', manejar((req) => fudo.desconectar(bid(req), req.user?.id)));
router.post('/sincronizar', manejar(async (req) => {
  // En segundo plano: la primera carga de 3 meses puede tardar más que un pedido HTTP.
  const est = await fudo.estado(bid(req));
  if (!est.conectado) return { error: 'fudo_no_conectado' };
  if (est.sincronizando) return { error: 'fudo_en_curso' };
  setImmediate(() => fudo.sincronizar(bid(req), { origen: 'manual' }).catch((e) => console.error('[fudo] sincronizar', bid(req), e.message)));
  return { ok: true, iniciado: true };
}));
router.get('/productos', manejar((req) => fudo.listarProductos(bid(req))));
router.patch('/productos', manejar((req) => fudo.vincular(bid(req), req.user?.id, req.body?.cambios)));

module.exports = router;
