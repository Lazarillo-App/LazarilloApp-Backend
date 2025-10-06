// src/routes/businesses.js
const express = require('express');
const router = express.Router();

const authRequired = require('../middleware/authMiddleware');

const businesses = require('../controllers/businessController');           // CRUD + active
const {
  listArticlesFromDB,
  listArticlesTreeFromDB,
  salesSummaryFromDB,
  salesSeriesFromDB,
  syncNow,
} = require('../controllers/syncController');

// 👇 si separaste el controller de Maxi (recomendado)
const maxi = require('../controllers/businessMaxiController');            // maxi-status / maxi-credentials

// 🔐 proteger todo este router
router.use(authRequired);

/* ================== Rutas por negocio (:id + sufijos) ================== */
router.get('/:id/articles',           listArticlesFromDB);
router.get('/:id/articles/tree',      listArticlesTreeFromDB);

router.post('/:id/sync',              syncNow);

router.get('/:id/sales/summary',      salesSummaryFromDB);
router.get('/:id/sales/:articuloId',  salesSeriesFromDB);

// Maxi credenciales/estado
router.get('/:id/maxi-status',        maxi.maxiStatus);        // o businesses.maxiStatus si lo dejaste ahí
router.post('/:id/maxi-credentials',  maxi.saveMaxiCredentials);// o businesses.maxiSave

/* ================== CRUD base ================== */
router.get('/',        businesses.listMine);
router.post('/',       businesses.create);

// ⚠️ IMPORTANTE: /active antes que "/:id"
router.get('/active',  businesses.getActive);
router.patch('/active',businesses.setActive);

/* ================== Operaciones por :id ================== */
router.get('/:id',     businesses.getOne);
router.patch('/:id',   businesses.update);
router.delete('/:id',  businesses.remove);
router.post('/:id/select', businesses.select);

module.exports = router;