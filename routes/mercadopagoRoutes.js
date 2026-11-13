// routes/mercadopagoRoutes.js
// Conexión con Mercado Pago (14/11/2026), por SUCURSAL: cada sucursal conecta su propia cuenta.
// Se monta bajo /api/businesses/:businessId/mercadopago; el guard global de /api corre antes.
// Solo owner y admin. ?sucursal= (0 o vacío = la principal). En /conectar la sucursal sale del
// estado firmado que viajó a Mercado Pago. Ver services/mercadopagoService.js.
const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireBusinessRole } = require('../middleware/authMiddleware');
const mp = require('../services/mercadopagoService');
const { validarSucursal } = require('../services/conciliacionService');

router.use(requireBusinessRole('admin'));
router.use(async (req, res, next) => {
  if (Number(req.params.businessId) !== Number(req.businessId)) {
    return res.status(403).json({ error: 'business_mismatch' });
  }
  try {
    const s = await validarSucursal(Number(req.businessId), req.query.sucursal);
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
    if (r && r.error) return res.status(r.error === 'mp_no_conectado' ? 404 : 400).json(r);
    res.json(r);
  } catch (e) {
    console.error('[mercadopago]', e);
    res.status(500).json({ error: 'mercadopago_error' });
  }
};

router.get('/estado', manejar((req) => mp.estado(bid(req), req.sucursal)));

router.get('/autorizar', manejar(async (req) => {
  if (!mp.configurado()) return { error: 'mp_sin_configurar' };
  return { url: mp.urlAutorizacion(bid(req), req.user?.id, req.sucursal) };
}));

router.post('/conectar', manejar((req) => mp.conectar(bid(req), req.user?.id, req.body?.code, req.body?.state)));

router.delete('/', manejar((req) => mp.desconectar(bid(req), req.sucursal)));

router.post('/sincronizar', manejar((req) => mp.sincronizarBanco(bid(req), req.sucursal, req.body?.desde, req.body?.hasta)));

module.exports = router;
