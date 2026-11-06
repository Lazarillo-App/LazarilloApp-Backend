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
//   del pulso: trae de MaxiRest las ventas que le faltan a Recetas (lo mismo que "Gestionar
//   ventas", runDailyAuto) y relee del kit lo que cambió para Balance (la misma ingesta que
//   corre cada hora). Responde enseguida; las dos cosas siguen en segundo plano.
// El front pinta un solo punto con la peor de las dos y el detalle en el tooltip.
// Fechas futuras (tickets cargados a propósito más adelante) no cuentan: tope mañana.

const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../config/db');
const { requireBusinessAccess } = require('../middleware/requireBusinessAccess');
const { runDailyAuto } = require('../services/salesSyncPolicy');
const { resolveCredsBizId } = require('../controllers/salesSyncController');
const { abrirCorrida, ejecutarCorrida, corridaEnCurso } = require('../services/gestion/render/sync');

const VEN_BALANCE = new Set(['owner', 'admin', 'service']);

// Negocios con la sync de Recetas disparada desde el pulso (un proceso: alcanza en memoria;
// runDailyAuto además tiene su propio candado en la base).
const recetasEnCurso = new Set();

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
    const actualizando = recetasEnCurso.has(businessId) || (conBalance && await balanceActualizando());
    res.set('Cache-Control', 'no-store');
    res.json({ recetas, balance, actualizando });
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

    // Recetas: ventas que faltan desde MaxiRest (credenciales del principal de la organización).
    let recetas = 'en_curso';
    if (!recetasEnCurso.has(businessId)) {
      recetasEnCurso.add(businessId);
      recetas = 'iniciado';
      setImmediate(async () => {
        try {
          const credsBizId = await resolveCredsBizId(businessId);
          const out = await runDailyAuto({ businessId, credsBizId });
          console.log('[pulso] recetas', businessId, JSON.stringify(out).slice(0, 300));
        } catch (e) {
          console.error('[pulso] recetas', businessId, e?.message || e);
        } finally {
          recetasEnCurso.delete(businessId);
        }
      });
    }

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
