// routes/businessRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { ensureInitialBackfillOnce } = require('../services/salesSyncPolicy');
const businesses = require('../controllers/businessController');
const {
  listArticlesFromDB,
  listArticlesTreeFromDB,
  salesSummaryFromDB,
  salesSeriesFromDB,
  syncNow,
} = require('../controllers/syncController');

// Diagnóstico / sync ventas (nuevo)
const { maxiPing, syncSalesForBusiness } = require('../controllers/salesSyncController');

/* =========================================================
   CARGA DE NEGOCIO POR :id  -> deja req.business listo
   - Valida que el usuario sea owner o tenga vínculo
   - Si no existe o no tiene acceso -> 404
   ========================================================= */
router.param('id', async (req, res, next, id) => {
  try {
    const bizId = Number(id);
    if (!Number.isFinite(bizId)) {
      return res.status(404).json({ error: 'not_found' });
    }

    // user viene del middleware de auth (JWT)
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const { rows } = await pool.query(
      `
      SELECT b.*
      FROM app_businesses b
      LEFT JOIN user_businesses ub
        ON ub.business_id = b.id AND ub.user_id = $2
      WHERE b.id = $1
        AND (b.owner_id = $2 OR ub.user_id IS NOT NULL)
      LIMIT 1
      `,
      [bizId, userId]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'not_found' });
    }

    req.business = rows[0]; // <- queda disponible en todos los handlers /:id/*
    next();
  } catch (err) {
    next(err);
  }
});

/* =================== MAXI: ping de rango =================== */
// GET /:id/maxi-ping?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/:id/maxi-ping', maxiPing);

/* ========================= CRUD base ======================= */
router.get('/', businesses.listMine);
router.post('/', businesses.create);

// Negocio activo (no usa :id)
router.get('/active', businesses.getActive);
router.patch('/active', businesses.setActive);

// Por :id  (usan req.business cargado por router.param)
router.get('/:id', (req, res) => res.json(req.business));
router.patch('/:id', businesses.update);
router.delete('/:id', businesses.remove);
router.post('/:id/select', businesses.select);

/* ============== Maxi credenciales / estado ================= */
// GET /:id/maxi-status
router.get('/:id/maxi-status', businesses.maxiStatus);

// POST /:id/maxi-credentials  { email, pass, codcli }
router.post('/:id/maxi-credentials', async (req, res, next) => {
  try {
    const { email, codcli } = req.body || {};
    const password = req.body?.password ?? req.body?.pass; // ✅ acepta ambos
    if (!email || !password || !codcli) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    return businesses.maxiSave(req, res, next);
  } catch (e) {
    next(e);
  }
});

/* ================ Datos / Sync “viejos” ==================== */
// Catálogo
router.get('/:id/articles', listArticlesFromDB);
router.get('/:id/articles/tree', listArticlesTreeFromDB);

// Ventas (peek & series) legacy
router.get('/:id/sales/summary', salesSummaryFromDB);
router.get('/:id/sales/:articuloId', salesSeriesFromDB);

/* ================ Sync ventas (nuevo) ====================== */
// POST /:id/sync-sales?mode=backfill_30d&dryrun=1&from=YYYY-MM-DD&to=YYYY-MM-DD
router.post('/:id/sync-sales', async (req, res, next) => {
  try {
    const bizId =
      Number(req.business?.id) ||
      Number(req.params.id) ||
      Number(req.headers['x-business-id']);

    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ error: 'invalid_business_id' });
    }

    const business = req.business || { id: bizId };

    const mode =
      (req.query.mode === 'backfill' || req.query.mode === 'backfill_30d')
        ? 'backfill_30d'
        : 'auto';

    const dryrun = req.query.dryrun === '1' || req.query.dryrun === 'true';

    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;
    if ((from && isNaN(+from)) || (to && isNaN(+to))) {
      return res.status(400).json({ error: 'invalid_date' });
    }

    const out = await syncSalesForBusiness(business, { mode, from, to, dryrun, req });
    res.json({ ok: true, business_id: bizId, sales: out });
  } catch (e) {
    next(e);
  }
});

// Sync legacy de catálogo y otras cosas
router.post('/:id/sync', async (req, res, next) => {
  try {
    // ejecutás tu syncNow “como hoy”
    const resp = await syncNow(req, res, next);

    // Disparar el backfill UNA SOLA VEZ (no bloquea la respuesta al front)
    ensureInitialBackfillOnce({ businessId: req.business.id, req })
      .then(r => console.log('[backfill-on-first-sync]', req.business.id, r))
      .catch(e => console.error('[backfill-on-first-sync] FAIL', req.business.id, e));

    return resp; // o res.json(...) si vos respondés acá
  } catch (e) {
    next(e);
  }
});

// routes/businessRoutes.js (abajo de otras rutas :id)
router.get('/:id/default-group', async (req, res, next) => {
  try {
    const biz = req.business; // lo cargó router.param
    const defaultId = biz?.props?.default_group_id ?? null;
    res.json({ ok: true, business_id: biz.id, default_group_id: defaultId });
  } catch (e) { next(e); }
});

router.patch('/:id/default-group', async (req, res, next) => {
  try {
    const biz = req.business;
    const groupId = (req.body?.groupId === null) ? null : Number(req.body?.groupId);
    if (groupId !== null && !Number.isFinite(groupId)) {
      return res.status(400).json({ error: 'invalid_group_id' });
    }
    await pool.query(
      `UPDATE app_businesses
         SET props = COALESCE(props,'{}'::jsonb) || jsonb_build_object('default_group_id', $2::int)
       WHERE id = $1`,
      [biz.id, groupId]
    );
    res.json({ ok: true, business_id: biz.id, default_group_id: groupId });
  } catch (e) { next(e); }
});

module.exports = router;
