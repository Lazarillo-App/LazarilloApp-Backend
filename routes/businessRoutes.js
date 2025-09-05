const express = require('express');
const router = express.Router();

const authRequired = require('../middleware/authMiddleware');
const businesses = require('../controllers/businessController');
const sync = require('../controllers/syncController');
const { loadActiveBusiness, requireBusiness } = require('../middleware/business');

// router.get('/:id/maxi-sales',
//   authRequired,
//   loadActiveBusiness,
//   requireBusiness,
//   businesses.maxiSalesLive // si no lo implementaste, comenta esta línea/ruta
// );

// Sync + lectura desde BD
router.post('/:id/sync',    authRequired, sync.syncNow);
router.get('/:id/sales',    authRequired, sync.listSalesFromDB);
router.get('/:id/articles', authRequired, sync.listArticlesFromDB);

// CRUD + selección
router.get('/',         authRequired, businesses.listMine);
router.post('/',        authRequired, businesses.create);
router.get('/active',   authRequired, businesses.getActive);
router.patch('/active', authRequired, businesses.setActive);
router.get('/:id',      authRequired, businesses.getOne);
router.patch('/:id',    authRequired, businesses.update);
router.delete('/:id',   authRequired, businesses.remove);
router.post('/:id/select', authRequired, businesses.select);

// Maxi (estado/credenciales/artículos)
router.get('/:id/maxi-status',       authRequired, businesses.maxiStatus);
router.post('/:id/maxi-credentials', authRequired, businesses.maxiSave);
router.get('/:id/maxi-articles',     authRequired, businesses.maxiArticles);

module.exports = router;
