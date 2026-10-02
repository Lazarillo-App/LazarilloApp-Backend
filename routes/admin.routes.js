const r = require('express').Router();

// Middlewares
const requireAppAdmin = require('../middleware/requireAppAdmin');
const allowAdminAsBusiness = require('../middleware/allowAdminAsBusiness');

// Controllers
const usersCtrl = require('../controllers/admin/adminUsersController');
const peekCtrl = require('../controllers/admin/adminPeekController');
const businessCtrl = require('../controllers/admin/adminBusinessController');
const orgCtrl = require('../controllers/admin/adminOrgController');
const maintenanceCtrl = require('../controllers/admin/adminMaintenanceController');
const assignmentsCtrl = require('../controllers/admin/adminAssignmentsController');
const auditCtrl = require('../controllers/admin/adminAuditController');
const searchCtrl = require('../controllers/admin/adminSearchController');
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
r.delete('/users/:id/hard', ensureFn('hardDeleteUser', usersCtrl?.hardDeleteUser));
r.post(  '/users/:id/restore',         ensureFn('restoreUser',   usersCtrl?.restoreUser));
r.post(  '/users/:id/reset-password',  ensureFn('resetPassword', usersCtrl?.resetPassword));
r.get(   '/users/:id',                 ensureFn('getUser',       usersCtrl?.getUser));
r.get(   '/users/:id/businesses',      ensureFn('userBusinesses', usersCtrl?.userBusinesses));
r.get(   '/users/:id/activity',        ensureFn('userActivity',   usersCtrl?.userActivity));

/* BUSCADOR GLOBAL */
r.get('/search', ensureFn('globalSearch', searchCtrl?.globalSearch));

/* DASHBOARD */
r.get('/dashboard/problemas', ensureFn('dashboardProblemas', businessCtrl?.dashboardProblemas));

/* NEGOCIOS */
r.get(   '/businesses',     ensureFn('listBusinesses', businessCtrl?.listBusinesses));
r.get(   '/businesses/:id', ensureFn('getBusiness',    businessCtrl?.getBusiness));
r.patch( '/businesses/:id', ensureFn('updateBusiness', businessCtrl?.updateBusiness));
r.post(  '/businesses/:id/pause',  ensureFn('pauseBusiness',  businessCtrl?.pauseBusiness));
r.post(  '/businesses/:id/resume', ensureFn('resumeBusiness', businessCtrl?.resumeBusiness));
r.post(  '/businesses/:id/reassign-owner', ensureFn('reassignOwner', businessCtrl?.reassignOwner));

/* ACCIONES "EN NOMBRE DE" (staff) */
r.delete('/assignments/:id', ensureFn('revokeAssignment', assignmentsCtrl?.revokeAssignment));
r.patch( '/assignments/:id', ensureFn('updateAssignmentRole', assignmentsCtrl?.updateAssignmentRole));

/* ORGANIZACIONES */
r.get('/organizations',     ensureFn('listOrganizations', orgCtrl?.listOrganizations));
r.get('/organizations/:id', ensureFn('getOrganization',   orgCtrl?.getOrganization));

/* AUDITORÍA DE PLATAFORMA */
r.get('/audit', ensureFn('listPlatformAudit', auditCtrl?.listPlatformAudit));

/* MANTENIMIENTO GLOBAL */
r.get( '/maintenance', ensureFn('getMaintenance', maintenanceCtrl?.getMaintenance));
r.post('/maintenance', ensureFn('setMaintenance', maintenanceCtrl?.setMaintenance));

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
