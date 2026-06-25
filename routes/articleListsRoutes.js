// routes/articleListsRoutes.js

const express = require('express');
const router = express.Router();

const { authRequired } = require('../middleware/authMiddleware');
const { requireBusinessAccessParam } = require('../middleware/requireBusinessAccess');

const lists = require('../controllers/articleListsController');
const links = require('../controllers/articleLinksController');

/* ───────── Helper anti-crash ───────── */
function ensureFn(name, fn) {
  if (typeof fn !== 'function') {
    console.warn(`[routes/articleLists] Handler faltante: ${name}`);
    return (_req, res) => res.status(501).json({ error: 'not_implemented', handler: name });
  }
  return fn;
}

/* ───────── Auth ───────── */
router.use(authRequired);
router.param('id', requireBusinessAccessParam);

/* ═══════════════════════════════════════════════════════════
   LISTAS DE ARTÍCULOS (sidebar)
   ═══════════════════════════════════════════════════════════ */

router.get(
  '/:id/article-lists',
  ensureFn('lists.getLists', lists.getLists)
);

router.post(
  '/:id/article-lists',
  ensureFn('lists.createList', lists.createList)
);

router.put(
  '/:id/article-lists/:listId',
  ensureFn('lists.updateList', lists.updateList)
);

router.delete(
  '/:id/article-lists/:listId',
  ensureFn('lists.deleteList', lists.deleteList)
);

router.get(
  '/:id/article-lists/:listId/items',
  ensureFn('lists.getListItems', lists.getListItems)
);

router.put(
  '/:id/article-lists/:listId/items',
  ensureFn('lists.addListItems', lists.addListItems)
);

router.delete(
  '/:id/article-lists/:listId/items/:articleId',
  ensureFn('lists.removeListItem', lists.removeListItem)
);

/* ═══════════════════════════════════════════════════════════
   VINCULACIONES (artículos gemelos)
   ═══════════════════════════════════════════════════════════ */

router.get(
  '/:id/article-links',
  ensureFn('links.getLinkGroups', links.getLinkGroups)
);

// ⚠️ propagations ANTES de /:groupId para que no se confunda con un id
router.get(
  '/:id/article-links/propagations',
  ensureFn('links.getPropagations', links.getPropagations)
);

router.get(
  '/:id/article-links/by-article/:articleId',
  ensureFn('links.getLinkByArticle', links.getLinkByArticle)
);

router.post(
  '/:id/article-links',
  ensureFn('links.createLinkGroup', links.createLinkGroup)
);

router.delete(
  '/:id/article-links/:groupId',
  ensureFn('links.deleteLinkGroup', links.deleteLinkGroup)
);

router.post(
  '/:id/article-links/:groupId/members',
  ensureFn('links.addMember', links.addMember)
);

router.delete(
  '/:id/article-links/:groupId/members/:articleId',
  ensureFn('links.removeMember', links.removeMember)
);

router.patch(
  '/:id/article-links/:groupId/members/:articleId',
  ensureFn('links.updateMember', links.updateMember)
);

router.post(
  '/:id/article-links/:groupId/propagate',
  ensureFn('links.propagateChange', links.propagateChange)
);

/* ═══════════════════════════════════════════════════════════
   LISTAS DE INSUMOS
   ═══════════════════════════════════════════════════════════ */

router.get('/:id/insumo-lists', ensureFn('lists.getInsumoLists', lists.getInsumoLists));
router.post('/:id/insumo-lists', ensureFn('lists.createInsumoList', lists.createInsumoList));
router.delete('/:id/insumo-lists/:listId', ensureFn('lists.deleteInsumoList', lists.deleteInsumoList));
router.get('/:id/insumo-lists/:listId/items', ensureFn('lists.getInsumoListItems', lists.getInsumoListItems));
router.put('/:id/insumo-lists/:listId/items', ensureFn('lists.addInsumoListItems', lists.addInsumoListItems));

module.exports = router;