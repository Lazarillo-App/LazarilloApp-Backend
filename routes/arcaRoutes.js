// routes/arcaRoutes.js
// ARCA automático (18/11/2026): Configuración › Conexiones › ARCA. Montado bajo
// /api/businesses/:businessId/arca. Solo owner y admin. La clave fiscal NUNCA pasa por acá: vive
// cifrada en la PC del cliente (ver services/arcaConexion.js); la PC habla por /api/kit/arca/*.
//   GET   /           estado: frecuencia, PC que trae, últimas subidas
//   PATCH /           { frecuencia: diaria | semanal | mensual | apagada }
//   POST  /traer      { desde, hasta }  «Traer ahora» con rango (la PC lo hace en su próxima consulta)
//   DELETE /traer     cancela el pedido pendiente
const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireBusinessRole } = require('../middleware/authMiddleware');
const arca = require('../services/arcaConexion');
const negocioDeLaUrl = require('../middleware/negocioDeLaUrl');

router.use((req, res, next) => { req.params.id = req.params.businessId; negocioDeLaUrl(req, res, next); });
router.use(requireBusinessRole('admin'));
router.use((req, res, next) => {
  if (Number(req.params.businessId) !== Number(req.businessId)) return res.status(403).json({ error: 'business_mismatch' });
  next();
});

const bid = (req) => Number(req.businessId);
const manejar = (fn) => async (req, res) => {
  try {
    const r = await fn(req);
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    console.error('[arca]', e.message);
    res.status(500).json({ error: 'arca_error' });
  }
};

router.get('/', manejar((req) => arca.estado(bid(req))));
router.patch('/', manejar((req) => arca.cambiarFrecuencia(bid(req), req.user?.id, req.body?.frecuencia)));
router.post('/traer', manejar((req) => arca.pedirAhora(bid(req), req.user?.id, req.body || {})));
router.delete('/traer', manejar((req) => arca.cancelarPedido(bid(req))));

module.exports = router;
