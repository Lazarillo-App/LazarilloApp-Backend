// routes/priceListsRoutes.js
// Listas de precios custom de Lazarillo (Salon, Mostrador, etc).

const router = require('express').Router({ mergeParams: true });
const ctrl = require('../controllers/priceListsController');

const noop = (_req, _res, next) => next();
const safe = (name) => (typeof ctrl[name] === 'function' ? ctrl[name] : (req, res) => {
  console.warn(`[routes/priceLists] Handler faltante: ${name}`);
  res.status(501).json({ ok: false, error: `not_implemented:${name}` });
});

// GET    /api/businesses/:id/price-lists                      → listas del negocio
router.get('/:id/price-lists', safe('getLists'));

// GET    /api/businesses/:id/price-lists/full-state           → listas + price_config
router.get('/:id/price-lists/full-state', safe('getFullState'));

// POST   /api/businesses/:id/price-lists                      → crear lista
router.post('/:id/price-lists', safe('createList'));

// PUT    /api/businesses/:id/price-lists/:listId              → actualizar
router.put('/:id/price-lists/:listId', safe('updateList'));

// POST   /api/businesses/:id/price-lists/:listId/set-favorite → marcar favorita
router.post('/:id/price-lists/:listId/set-favorite', safe('setFavorite'));

// DELETE /api/businesses/:id/price-lists/:listId              → eliminar
router.delete('/:id/price-lists/:listId', safe('deleteList'));

module.exports = router;