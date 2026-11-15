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

// Al abrir Movimientos bancarios: si una cuenta no terminó su historial y nadie lo está trayendo, arranca.
router.get('/estado', manejar((req) => {
  require('../services/mercadopagoDiario').asegurarHistorial(bid(req)).catch((e) => console.warn('[mercadopago] historial:', e.message));
  return mp.estado(bid(req), req.sucursal);
}));

router.get('/autorizar', manejar(async (req) => {
  if (!mp.configurado()) return { error: 'mp_sin_configurar' };
  return { url: mp.urlAutorizacion(bid(req), req.user?.id, req.sucursal) };
}));

router.post('/conectar', manejar(async (req) => {
  const r = await mp.conectar(bid(req), req.user?.id, req.body?.code, req.body?.state);
  // Al vincular (Diego 15/11): se guarda el CUIT de la cuenta y se completa el de la sucursal si estaba vacío.
  if (!r?.error) require('../services/clientesService').docsPropios(bid(req)).catch((e) => console.warn('[mercadopago] CUIT al vincular:', e.message));
  // Al vincular se trae el historial en segundo plano, sin esperar al cron (Diego 15/11: «ya está vinculado
  // pero Clientes sigue vacío»). Avisa en la campana cuando termina.
  if (!r?.error) require('../services/mercadopagoDiario').asegurarHistorial(bid(req)).catch((e) => console.warn('[mercadopago] historial al vincular:', e.message));
  return r;
}));

router.delete('/', manejar((req) => mp.desconectar(bid(req), req.sucursal, req.query.cuenta || null)));

// Proveedor de la cuenta (Diego 15/11: «al asociar un banco lo tenemos que vincular con un proveedor»).
router.post('/proveedor', manejar(async (req) => {
  const r = await mp.vincularProveedor(bid(req), req.sucursal, req.body?.cuenta, req.body?.codPro);
  if (!r.error) {
    require('../services/notificationService').avisarAbm(req, {
      businessId: bid(req), type: 'mp_proveedor',
      title: r.proveedor ? `Mercado Pago ${r.cuenta}: proveedor ${r.proveedor.nombre}` : `Mercado Pago ${r.cuenta}: sin proveedor`,
      message: r.heredadas ? `También quedó en ${r.heredadas} cuenta${r.heredadas === 1 ? '' : 's'} más de la organización que no tenía${r.heredadas === 1 ? '' : 'n'} proveedor.` : null,
      metadata: { link: '/configuracion?tab=7' },
    });
  }
  return r;
}));

// Qué cuenta define el CUIT de la sucursal (Diego 15/11: «se elige qué cuenta manda, bien clarito»).
router.post('/cuit-sucursal', manejar(async (req) => {
  const r = await mp.usarCuitDeCuenta(bid(req), req.sucursal, req.body?.cuenta);
  if (!r.error) {
    require('../services/notificationService').avisarAbm(req, {
      businessId: bid(req), type: 'cuit_sucursal',
      title: `CUIT de ${r.sucursal}: ${r.cuit} (cuenta ${r.cuenta})`,
      message: r.antes && r.antes !== r.cuit ? `Antes: ${r.antes} → ahora: ${r.cuit}` : null,
      metadata: { link: '/configuracion?tab=7' },
    });
  }
  return r;
}));

router.post('/sincronizar', manejar((req) => mp.sincronizarBanco(bid(req), req.sucursal, req.body?.desde, req.body?.hasta)));

// Reporte de liberaciones (nombres de pagadores y egresos): MP lo arma en unos minutos, el front
// vuelve a preguntar acá hasta que esté.
router.post('/reporte', manejar((req) => mp.aplicarReporte(bid(req), req.sucursal, req.body?.desde, req.body?.hasta)));

// Clientes (14/11): los que pagaron por Mercado Pago, de todas las sucursales del negocio.
router.get('/clientes', manejar((req) => require('../services/clientesService').clientes(bid(req))));

module.exports = router;
