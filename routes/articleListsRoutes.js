// routes/articleListsRoutes.js

const express = require('express');
const router  = express.Router();

const { authRequired }              = require('../middleware/authMiddleware');
const { requireBusinessAccessParam } = require('../middleware/requireBusinessAccess');

const lists = require('../controllers/articleListsController');
const links = require('../controllers/articleLinksController');

/* ───────── Helper anti-crash (mismo patrón que businessRoutes) ───────── */
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
   LISTAS DE ARTÍCULOS
   ═══════════════════════════════════════════════════════════ */

// GET    /api/businesses/:id/article-lists              → todas las listas del negocio
router.get(
  '/:id/article-lists',
  ensureFn('lists.getLists', lists.getLists)
);

// POST   /api/businesses/:id/article-lists              → crear lista
router.post(
  '/:id/article-lists',
  ensureFn('lists.createList', lists.createList)
);

// PUT    /api/businesses/:id/article-lists/:listId      → renombrar / actualizar lista
router.put(
  '/:id/article-lists/:listId',
  ensureFn('lists.updateList', lists.updateList)
);

// DELETE /api/businesses/:id/article-lists/:listId      → eliminar lista
router.delete(
  '/:id/article-lists/:listId',
  ensureFn('lists.deleteList', lists.deleteList)
);

// GET    /api/businesses/:id/article-lists/:listId/items        → artículos de la lista
router.get(
  '/:id/article-lists/:listId/items',
  ensureFn('lists.getListItems', lists.getListItems)
);

// PUT    /api/businesses/:id/article-lists/:listId/items        → agregar artículos { ids: [] }
router.put(
  '/:id/article-lists/:listId/items',
  ensureFn('lists.addListItems', lists.addListItems)
);

// DELETE /api/businesses/:id/article-lists/:listId/items/:articleId → quitar artículo
router.delete(
  '/:id/article-lists/:listId/items/:articleId',
  ensureFn('lists.removeListItem', lists.removeListItem)
);

/* ═══════════════════════════════════════════════════════════
   VINCULACIONES
   ═══════════════════════════════════════════════════════════ */

// GET    /api/businesses/:id/article-links              → todos los grupos del negocio (con miembros)
router.get(
  '/:id/article-links',
  ensureFn('links.getLinkGroups', links.getLinkGroups)
);

// GET    /api/businesses/:id/article-links/propagations → historial para notificaciones
// ⚠️ Este route DEBE ir ANTES de /:id/article-links/:groupId para que "propagations"
//    no sea interpretado como un groupId
router.get(
  '/:id/article-links/propagations',
  ensureFn('links.getPropagations', links.getPropagations)
);

// GET    /api/businesses/:id/article-links/by-article/:articleId → grupo de un artículo
router.get(
  '/:id/article-links/by-article/:articleId',
  ensureFn('links.getLinkByArticle', links.getLinkByArticle)
);

// POST   /api/businesses/:id/article-links              → crear grupo { articleIds, name? }
router.post(
  '/:id/article-links',
  ensureFn('links.createLinkGroup', links.createLinkGroup)
);

// DELETE /api/businesses/:id/article-links/:groupId     → eliminar grupo completo
router.delete(
  '/:id/article-links/:groupId',
  ensureFn('links.deleteLinkGroup', links.deleteLinkGroup)
);

router.post(
'/:id/article-links/:groupId/members',
  ensureFn('links.addMember', links.addMember)
);

// DELETE /api/businesses/:id/article-links/:groupId/members/:articleId → sacar 1 artículo
router.delete(
  '/:id/article-links/:groupId/members/:articleId',
  ensureFn('links.removeMember', links.removeMember)
);

// PATCH /api/businesses/:id/article-links/:groupId/members/:articleId → actualizar objetivo
router.patch(
  '/:id/article-links/:groupId/members/:articleId',
  ensureFn('links.updateMemberObjetivo', links.updateMemberObjetivo)
);

// POST   /api/businesses/:id/article-links/:groupId/propagate → registrar propagación
router.post(
  '/:id/article-links/:groupId/propagate',
  ensureFn('links.propagateChange', links.propagateChange)
);

/* ── Listas de Insumos ─────────────────────────────────────────────────────── */
router.get('/:id/insumo-lists',                          ensureFn('lists.getInsumoLists',    lists.getInsumoLists));
router.post('/:id/insumo-lists',                         ensureFn('lists.createInsumoList',  lists.createInsumoList));
router.delete('/:id/insumo-lists/:listId',               ensureFn('lists.deleteInsumoList',  lists.deleteInsumoList));
router.get('/:id/insumo-lists/:listId/items',            ensureFn('lists.getInsumoListItems', lists.getInsumoListItems));
router.put('/:id/insumo-lists/:listId/items',            ensureFn('lists.addInsumoListItems', lists.addInsumoListItems));

module.exports = router;