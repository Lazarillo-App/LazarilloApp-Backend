// routes/businessRoutes.js
const express = require('express');
const router = express.Router();

const authRequired = require('../middleware/authMiddleware');
const businesses   = require('../controllers/businessController');

// puedes importar todo el objeto...
const sync = require('../controllers/syncController');
// ...o desestructurar si preferís:
// const { syncNow, listArticlesFromDB, salesSummaryFromDB, salesSeriesFromDB } = require('../controllers/syncController');

// --- SOLO BD (nunca devolvemos datos directos de MAXI) ---
router.post('/:id/sync',            authRequired, sync.syncNow);
router.get('/:id/articles',         authRequired, sync.listArticlesFromDB);
router.get('/:id/sales/summary',    authRequired, sync.salesSummaryFromDB);
router.get('/:id/sales/:articuloId',authRequired, sync.salesSeriesFromDB);

// --- CRUD + selección ---
router.get('/',         authRequired, businesses.listMine);
router.post('/',        authRequired, businesses.create);
router.get('/active',   authRequired, businesses.getActive);
router.patch('/active', authRequired, businesses.setActive);
router.get('/:id',      authRequired, businesses.getOne);
router.patch('/:id',    authRequired, businesses.update);
router.delete('/:id',   authRequired, businesses.remove);
router.post('/:id/select', authRequired, businesses.select);

// --- Config/estado MAXI (solo credenciales/estado)

router.get('/:id/maxi-status',       authRequired, businesses.maxiStatus);
router.post('/:id/maxi-credentials', authRequired, businesses.maxiSave);

module.exports = router;
