const r = require('express').Router();

// Middlewares
const requireAppAdmin = require('../middleware/requireAppAdmin');
const allowAdminAsBusiness = require('../middleware/allowAdminAsBusiness');

// Controllers
const usersCtrl = require('../controllers/admin/adminUsersController');
const peekCtrl = require('../controllers/admin/adminPeekController');
const businessCtrl = require('../controllers/admin/adminBusinessController');
const orgCtrl = require('../controllers/admin/adminOrgController');
const salesSync = require('../controllers/salesSyncController');

function ensureFn(name, fn) {
  if (typeof fn === 'function') return fn;
  console.warn(`[routes/admin] Handler faltante: ${name} -> responderá 501`);
  return (_req, res) => res.status(501).json({ error: 'not_implemented', handler: name });
}

// Solo para app_admin
r.use(requireAppAdmin);

/* OVERVIEW */
r.get('/overview', ensureFn('overview', usersCtrl?.overview));

/* USUARIOS */
r.get(   '/users',          ensureFn('listUsers',    usersCtrl?.listUsers));
r.post(  '/users',          ensureFn('createUser',   usersCtrl?.createUser));
r.patch( '/users/:id',      ensureFn('updateUser',   usersCtrl?.updateUser));
r.delete('/users/:id',      ensureFn('deleteUser',   usersCtrl?.deleteUser));
r.post(  '/users/:id/restore',         ensureFn('restoreUser',   usersCtrl?.restoreUser));
r.post(  '/users/:id/reset-password',  ensureFn('resetPassword', usersCtrl?.resetPassword));
r.get(   '/users/:id',                 ensureFn('getUser',       usersCtrl?.getUser));
r.get(   '/users/:id/businesses',      ensureFn('userBusinesses', usersCtrl?.userBusinesses));
r.get(   '/users/:id/activity',        ensureFn('userActivity',   usersCtrl?.userActivity));

/* NEGOCIOS */
r.get(   '/businesses',     ensureFn('listBusinesses', businessCtrl?.listBusinesses));
r.get(   '/businesses/:id', ensureFn('getBusiness',    businessCtrl?.getBusiness));
r.patch( '/businesses/:id', ensureFn('updateBusiness', businessCtrl?.updateBusiness));

/* ORGANIZACIONES */
r.get('/organizations',     ensureFn('listOrganizations', orgCtrl?.listOrganizations));
r.get('/organizations/:id', ensureFn('getOrganization',   orgCtrl?.getOrganization));

/* PEEK / AUDITORÍA (solo lectura) */
r.get('/businesses/:id/ventas/summary',
  allowAdminAsBusiness,
  ensureFn('peekVentasSummary', peekCtrl?.peekVentasSummary)
);

r.get('/businesses/:id/articles/tree',
  allowAdminAsBusiness,
  ensureFn('peekArticlesTree', peekCtrl?.peekArticlesTree)
);

r.get('/businesses/:id/ventas/by-article',
  allowAdminAsBusiness,
  ensureFn('peekVentasSeries', peekCtrl?.peekVentasSeries)
);

r.get('/businesses/:id/maxi-status',
  allowAdminAsBusiness,
  ensureFn('peekMaxiStatus', peekCtrl?.peekMaxiStatus)
);

r.get('/businesses/:id/maxi-menu',
  allowAdminAsBusiness,
  ensureFn('peekMaxiMenuCache', peekCtrl?.peekMaxiMenuCache)
);

/* SYNC VENTAS (admin ejecuta para un negocio) */
r.post('/businesses/:id/sync-sales',
  allowAdminAsBusiness,
  ensureFn('adminSyncSales', salesSync.adminSyncSales)
);

module.exports = r;
