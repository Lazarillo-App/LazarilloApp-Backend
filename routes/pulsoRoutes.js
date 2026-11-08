// routes/pulsoRoutes.js
// Pulso del header (Diego, 06/11/2026): qué tan al día están los datos del negocio, por fuente.
//   GET  /api/businesses/:businessId/pulso
//   - recetas: lo que usa Recetas (sync de la app con MaxiRest): último día de ventas
//     (sales_daily_items) y última compra (purchases).
//   - balance: lo que usa Balance (lo que sube el kit y se lee cada hora): último día de
//     ventas y compras de gestion + última lectura OK. Solo para dueño/admin, que son los
//     que ven Balance; a staff le llega null.
//   - actualizando: true mientras corre lo que disparó POST /actualizar (o la ingesta del kit).
//   POST /api/businesses/:businessId/pulso/actualizar  (dueño/admin) — el "actualizar ahora"
//   del pulso. Todo sale del KIT (lo que sube cada PC a Render), no de MaxiRest online:
//   - Balance: relee del kit lo que cambió (la misma ingesta que corre cada hora).
//   - Recetas: los pipelines de Mairene que leen del kit — ventas del 12
//     (syncVentasDeNegocio → sales_daily_items) y compras/pagos del 25 y el 80
//     (syncComprasDeNegocio → purchases, con cascada a los costos de las recetas).
//     Antes usaba runDailyAuto (API de MaxiRest online, cortada desde octubre). Diego, 06/11.
//     La lógica vive en services/recetasDesdeKit.js (la usa también el reloj de cada hora).
//   Responde enseguida; todo sigue en segundo plano.
// El front pinta un solo punto con la peor de las dos y el detalle en el tooltip.
//   - kit (Diego, 08/11: "no sé si está atrasado o que no hay compras cargadas"): cuándo subió
//     el kit por última vez y hasta qué fecha llega lo que subió (services/kit/frescuraKit.js).
//     El front juzga el punto por la SUBIDA y por si la app ya tomó todo, no por la fecha del
//     último dato (un local puede no tener compras hace semanas y estar al día).
// Fechas futuras (tickets cargados a propósito más adelante) no cuentan: tope mañana.

const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../config/db');
const { requireBusinessAccess } = require('../middleware/requireBusinessAccess');
const { dispararRecetas, recetasEnCurso } = require('../services/recetasDesdeKit');
const { frescuraKit, olvidarFrescura } = require('../services/kit/frescuraKit');
const { abrirCorrida, ejecutarCorrida, corridaEnCurso } = require('../services/gestion/render/sync');

const VEN_BALANCE = new Set(['owner', 'admin', 'service']);

async function balanceActualizando() {
  try { return !!(await corridaEnCurso()); } catch { return false; }
}

router.get('/', requireBusinessAccess, async (req, res, next) => {
  try {
    const businessId = Number(req.businessId);
    const conBalance = VEN_BALANCE.has(req.businessRole);
    const { rows } = await pool.query(
      `SELECT
         (SELECT to_char(MAX(day), 'YYYY-MM-DD') FROM sales_daily_items
           WHERE business_id = $1 AND day <= now() + interval '1 day') AS r_ventas,
         (SELECT to_char(MAX(fecha)::date, 'YYYY-MM-DD') FROM purchases
           WHERE business_id = $1 AND fecha <= now() + interval '1 day') AS r_compras,
         CASE WHEN $2 THEN (SELECT to_char(MAX(fecha)::date, 'YYYY-MM-DD') FROM gestion_ventas
           WHERE business_id = $1 AND fecha <= now() + interval '1 day') END AS b_ventas,
         CASE WHEN $2 THEN (SELECT to_char(MAX(fecha)::date, 'YYYY-MM-DD') FROM gestion_compras
           WHERE business_id = $1 AND fecha <= now() + interval '1 day') END AS b_compras,
         CASE WHEN $2 THEN (SELECT MAX("creadoEn") FROM gestion_import_logs
           WHERE estado = 'ok' AND business_id = $1) END AS b_importado`,
      [businessId, conBalance]
    );
    const r = rows[0] || {};
    const recetas = (r.r_ventas || r.r_compras)
      ? { ventas: r.r_ventas || null, compras: r.r_compras || null }
      : null;
    const balance = conBalance && (r.b_ventas || r.b_compras)
      ? {
          ventas: r.b_ventas || null,
          compras: r.b_compras || null,
          importado: r.b_importado ? new Date(r.b_importado).toISOString() : null,
        }
      : null;
    const actualizando = recetasEnCurso(businessId) || (conBalance && await balanceActualizando());
    let kit = null;
    try { kit = await frescuraKit(businessId); } catch (e) { console.warn('[pulso] kit', e.message); }
    res.set('Cache-Control', 'no-store');
    res.json({ recetas, balance, kit, actualizando });
  } catch (e) {
    next(e);
  }
});

router.post('/actualizar', requireBusinessAccess, async (req, res, next) => {
  try {
    if (!VEN_BALANCE.has(req.businessRole)) {
      return res.status(403).json({ ok: false, error: 'forbidden', need: 'admin' });
    }
    const businessId = Number(req.businessId);
    olvidarFrescura(businessId);

    // Recetas: ventas (12) y compras/pagos (25, 80) desde el kit (services/recetasDesdeKit.js;
    // el mismo proceso corre solo cada hora cuando el kit sube algo nuevo).
    const recetas = dispararRecetas(businessId, 'pulso');

    // Balance: la ingesta del kit (lee solo lo que cambió; candado compartido con el cron).
    let balance = 'en_curso';
    const id = await abrirCorrida('pulso');
    if (id != null) {
      balance = 'iniciado';
      setImmediate(() => {
        ejecutarCorrida(id, 'pulso').catch((e) => console.error('[pulso] balance', e?.message || e));
      });
    }

    res.status(202).json({ ok: true, recetas, balance });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
