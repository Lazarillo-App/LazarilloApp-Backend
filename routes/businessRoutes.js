// routes/businessRoutes.js
const express = require('express');
const router = express.Router();
const authRequired = require('../middleware/authMiddleware');
const businesses = require('../controllers/businessController');
const sync = require('../controllers/syncController');

// --- Sync + lectura desde BD (siempre con auth)
router.post('/:id/sync', authRequired, sync.syncNow);
router.get('/:id/articles', authRequired, sync.listArticlesFromDB);

// --- CRUD + selección
router.get('/', authRequired, businesses.listMine);
router.post('/', authRequired, businesses.create);
router.get('/active', authRequired, businesses.getActive);
router.patch('/active', authRequired, businesses.setActive);

router.get('/:id', authRequired, businesses.getOne);
router.patch('/:id', authRequired, businesses.update);
router.delete('/:id', authRequired, businesses.remove);
router.post('/:id/select', authRequired, businesses.select);

// --- Maxi (compat / debug)
router.get('/:id/maxi-status', authRequired, businesses.maxiStatus);
router.post('/:id/maxi-credentials', authRequired, businesses.maxiSave);
router.get('/:id/maxi-articles', authRequired, businesses.maxiArticles);

module.exports = router;
