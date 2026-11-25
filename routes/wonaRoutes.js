// routes/wonaRoutes.js
// Wona Sports (25/11/2026): conexión del negocio con una sede de Wona y sincronización. Se monta bajo
// /api/businesses/:businessId/wona; el guard global de /api corre antes. Solo owner y admin. El usuario
// y la clave entran y nunca vuelven a salir (estado no los devuelve). Ver services/wonaService.js.
const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireBusinessRole } = require('../middleware/authMiddleware');
const wona = require('../services/wonaService');
const negocioDeLaUrl = require('../middleware/negocioDeLaUrl');

router.use((req, res, next) => { req.params.id = req.params.businessId; negocioDeLaUrl(req, res, next); });
router.use(requireBusinessRole('admin'));
router.use((req, res, next) => {
  if (Number(req.params.businessId) !== Number(req.businessId)) return res.status(403).json({ error: 'business_mismatch' });
  next();
});

const bid = (req) => Number(req.businessId);
const STATUS = { wona_no_conectado: 404, wona_en_curso: 409, wona_vencido: 409, wona_claves_invalidas: 401, wona_caido: 502 };
const manejar = (fn) => async (req, res) => {
  try {
    const r = await fn(req);
    if (r && r.error) return res.status(STATUS[r.error] || 400).json(r);
    res.json(r);
  } catch (e) {
    console.error('[wona]', e.message);
    res.status(502).json({ error: 'wona_error', message: 'No se pudo hablar con Wona. Probá de nuevo en unos minutos.' });
  }
};

router.get('/estado', manejar((req) => wona.estado(bid(req))));
// Lista las sedes de la cuenta para elegir cuál va a este negocio (no guarda nada).
router.post('/sedes', manejar((req) => wona.sedes({ usuario: req.body?.usuario, clave: req.body?.clave })));
router.post('/conectar', manejar((req) => wona.conectar(bid(req), req.user?.id, {
  usuario: req.body?.usuario, clave: req.body?.clave, tenantUuid: req.body?.tenantUuid, branchId: req.body?.branchId, traer: req.body?.traer,
})));
router.delete('/', manejar((req) => wona.desconectar(bid(req), req.user?.id)));
router.post('/sincronizar', manejar(async (req) => {
  const est = await wona.estado(bid(req));
  if (!est.conectado) return { error: 'wona_no_conectado' };
  if (est.sincronizando) return { error: 'wona_en_curso' };
  setImmediate(() => wona.sincronizar(bid(req), { origen: 'manual' }).catch((e) => console.error('[wona] sincronizar', bid(req), e.message)));
  return { ok: true, iniciado: true };
}));

module.exports = router;
