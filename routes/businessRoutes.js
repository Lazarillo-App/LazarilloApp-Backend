// routes/businessRoutes.js
const express = require('express');
const router = express.Router();

const pool = require('../config/db');

// Controllers existentes
const businesses = require('../controllers/businessController');
const {
  listArticlesFromDB,
  listArticlesTreeFromDB,
  salesSummaryFromDB,
  salesSeriesFromDB,
  syncNow,
} = require('../controllers/syncController');

// Nuevo: sync de ventas
const { maxiPing, syncSalesForBusiness } = require('../controllers/salesSyncController');

/**
 * Valida pertenencia y adjunta req.businessId / req.business
 * (se ejecuta para cualquier ruta con :id)
 */
router.param('id', async (req, res, next, id) => {
  try {
    const uid = Number(req.user?.id);
    const bizId = Number(id);

    if (!Number.isFinite(uid) || !Number.isFinite(bizId)) {
      return res.status(400).json({ error: 'invalid_business_id' });
    }

    // Log mínimo para ver uid/bizId en consola del server
    console.log('businessRoutes:param check', { uid, bizId });

    const { rows } = await pool.query(
      `SELECT b.*
         FROM app_businesses b
        WHERE b.id = $1
          AND (
            b.owner_id = $2
            OR EXISTS (
              SELECT 1
                FROM user_businesses ub
               WHERE ub.business_id = b.id
                 AND ub.user_id = $2
            )
          )
        LIMIT 1`,
      [bizId, uid]
    );

    if (!rows[0]) {
      console.warn('businessRoutes:param not_found', { uid, bizId });
      return res.status(404).json({ error: 'not_found' });
    }

    req.businessId = bizId;
    req.business   = rows[0]; // props puede venir, o lo resolvemos después
    next();
  } catch (e) {
    console.error('router.param(id) error:', e);
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/:id/maxi-ping', maxiPing);

/* ===== CRUD base (sin activo requerido) ===== */
router.get('/',         businesses.listMine);
router.post('/',        businesses.create);
router.get('/active',   businesses.getActive);
router.patch('/active', businesses.setActive);  // espera { businessId }

/* ===== Operaciones por :id ===== */
router.get('/:id',                 businesses.getOne);
router.patch('/:id',               businesses.update);
router.delete('/:id',              businesses.remove);
router.post('/:id/select',         businesses.select);

// Maxi (estado/credenciales)
router.get('/:id/maxi-status',       businesses.maxiStatus);
router.post('/:id/maxi-credentials', businesses.maxiSave);

// Datos / Sync (existentes)
router.get('/:id/articles',          listArticlesFromDB);
router.get('/:id/articles/tree',     listArticlesTreeFromDB);
router.post('/:id/sync',             syncNow);

router.get('/:id/sales/summary',     salesSummaryFromDB);
router.get('/:id/sales/:articuloId', salesSeriesFromDB);

//Sync de ventas (backfill 30d o incremental)
router.post('/:id/sync-sales', async (req, res, next) => {
  try {
    const business = req.business;
    const mode = (req.query.mode === 'backfill') ? 'backfill_30d' : 'auto';
    const out = await syncSalesForBusiness(business, { mode, req });
    res.json({ ok: true, business_id: business.id, sales: out });
  } catch (e) { next(e); }
});

module.exports = router;
