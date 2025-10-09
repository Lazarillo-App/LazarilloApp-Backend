// src/routes/businesses.js
const express = require('express');
const router = express.Router();
const businesses = require('../controllers/businessController');
const {
  listArticlesFromDB, listArticlesTreeFromDB,
  salesSummaryFromDB, salesSeriesFromDB, syncNow
} = require('../controllers/syncController');

// 👇 valida pertenencia y adjunta req.businessId/req.business
router.param('id', async (req, res, next, id) => {
  const pool = require('../config/db');
  const uid = req.user?.id;
  const bizId = Number(id);
  if (!uid || !bizId) return res.status(400).json({ error: 'invalid_business_id' });

  const { rows } = await pool.query(`
    SELECT b.*
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id = b.id
     WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2)
     LIMIT 1
  `, [bizId, uid]);

  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  req.businessId = bizId;
  req.business = rows[0];
  next();
});

/* ===== CRUD base (sin negocio activo requerido) ===== */
router.get('/',        businesses.listMine);
router.post('/',       businesses.create);
router.get('/active',  businesses.getActive);
router.patch('/active',businesses.setActive);

/* ===== Operaciones por :id ===== */
router.get('/:id',                 businesses.getOne);
router.patch('/:id',               businesses.update);
router.delete('/:id',              businesses.remove);
router.post('/:id/select',         businesses.select);

// Maxi
router.get('/:id/maxi-status',     businesses.maxiStatus);
router.post('/:id/maxi-credentials', businesses.maxiSave);

// Datos / sync
router.get('/:id/articles',        listArticlesFromDB);
router.get('/:id/articles/tree',   listArticlesTreeFromDB);
router.post('/:id/sync',           syncNow);
router.get('/:id/sales/summary',   salesSummaryFromDB);
router.get('/:id/sales/:articuloId', salesSeriesFromDB);

module.exports = router;
