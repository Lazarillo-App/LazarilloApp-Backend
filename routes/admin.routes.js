const r = require('express').Router();

// Middlewares
const requireAppAdmin = require('../middleware/requireAppAdmin');
const allowAdminAsBusiness = require('../middleware/allowAdminAsBusiness');

// Controllers
const adminCtrl = require('../controllers/adminController');
const salesSync = require('../controllers/salesSyncController'); 

function ensureFn(name, fn) {
  if (typeof fn === 'function') return fn;
  console.warn(`[routes/admin] Handler faltante: ${name} -> responderá 501`);
  return (_req, res) => res.status(501).json({ error: 'not_implemented', handler: name });
}

// Solo para app_admin
r.use(requireAppAdmin);

/* USUARIOS */
r.get(   '/users',          ensureFn('listUsers',    adminCtrl?.listUsers));
r.post(  '/users',          ensureFn('createUser',   adminCtrl?.createUser));
r.patch( '/users/:id',      ensureFn('updateUser',   adminCtrl?.updateUser));
r.delete('/users/:id',      ensureFn('deleteUser',   adminCtrl?.deleteUser));

/* NEGOCIOS */
r.get(   '/businesses',     ensureFn('listBusinesses',   adminCtrl?.listBusinesses));
r.post(  '/businesses',     ensureFn('createBusiness',   adminCtrl?.createBusiness));
r.patch( '/businesses/:id', ensureFn('updateBusiness',   adminCtrl?.updateBusiness));
r.delete('/businesses/:id', ensureFn('deleteBusiness',   adminCtrl?.deleteBusiness));

/* PEEK / AUDITORÍA (solo lectura) */
r.get('/businesses/:id/ventas/summary',
  allowAdminAsBusiness,
  ensureFn('peekVentasSummary', adminCtrl?.peekVentasSummary)
);

r.get('/businesses/:id/articles/tree',
  allowAdminAsBusiness,
  ensureFn('peekArticlesTree', adminCtrl?.peekArticlesTree)
);

r.get('/businesses/:id/ventas/by-article',
  allowAdminAsBusiness,
  ensureFn('peekVentasSeries', adminCtrl?.peekVentasSeries)
);

r.get('/businesses/:id/maxi-status',
  allowAdminAsBusiness,
  ensureFn('peekMaxiStatus', adminCtrl?.peekMaxiStatus)
);

r.get('/businesses/:id/maxi-menu',
  allowAdminAsBusiness,
  ensureFn('peekMaxiMenuCache', adminCtrl?.peekMaxiMenuCache)
);

/* SYNC VENTAS (admin ejecuta para un negocio) */
r.post('/businesses/:id/sync-sales',
  allowAdminAsBusiness,
  ensureFn('adminSyncSales', salesSync.adminSyncSales)
);

module.exports = r;
