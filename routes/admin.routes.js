// routes/admin.routes.js
const r = require('express').Router();

// Middlewares
const requireAppAdmin = require('../middleware/requireAppAdmin');
const allowAdminAsBusiness = require('../middleware/allowAdminAsBusiness');

// Controllers
const adminCtrl = require('../controllers/adminController');
const salesSync = require('../controllers/salesSyncController'); 

// ───────────────── helpers defensivos ─────────────────
function ensureFn(name, fn) {
  if (typeof fn === 'function') return fn;
  console.warn(`[routes/admin] Handler faltante: ${name} -> responderá 501`);
  return (_req, res) => res.status(501).json({ error: 'not_implemented', handler: name });
}

// Este router es SOLO para app_admin
r.use(requireAppAdmin);

/* ─────────── USUARIOS (plataforma) ─────────── */
r.get(   '/users',          ensureFn('listUsers',    adminCtrl?.listUsers));
r.post(  '/users',          ensureFn('createUser',   adminCtrl?.createUser));
r.patch( '/users/:id',      ensureFn('updateUser',   adminCtrl?.updateUser));
r.delete('/users/:id',      ensureFn('deleteUser',   adminCtrl?.deleteUser));

/* ─────────── NEGOCIOS (ABM plataforma) ─────────── */
r.get(   '/businesses',     ensureFn('listBusinesses',   adminCtrl?.listBusinesses));
r.post(  '/businesses',     ensureFn('createBusiness',   adminCtrl?.createBusiness));
r.patch( '/businesses/:id', ensureFn('updateBusiness',   adminCtrl?.updateBusiness));
r.delete('/businesses/:id', ensureFn('deleteBusiness',   adminCtrl?.deleteBusiness));

/* ─────────── PEEK / AUDITORÍA (solo lectura) ───────────
   allowAdminAsBusiness fija req.businessId / req.business leyendo:
   - param :id
   - ó header X-As-Business-Id
   - ó query ?as_business_id=
*/
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

/* ─────────── SYNC VENTAS (admin ejecuta para un negocio) ─────────── */
// r.post('/businesses/:id/sync-sales',
//   allowAdminAsBusiness,
//   async (req, res, next) => {
//     try {
//       const bizId = req.businessId; // seteado por allowAdminAsBusiness
//       const mode =
//         (req.query.mode === 'backfill' || req.query.mode === 'backfill_30d')
//           ? 'backfill_30d'
//           : 'auto';
//       const dryrun = req.query.dryrun === '1' || req.query.dryrun === 'true';
//       const from = req.query.from ? new Date(req.query.from) : null;
//       const to   = req.query.to   ? new Date(req.query.to)   : null;

//       const out = await syncSalesForBusiness(
//         req.business || { id: bizId },
//         { mode, from, to, dryrun, req }
//       );

//       res.json({ ok: true, business_id: bizId, sales: out });
//     } catch (e) { next(e); }
//   }
// );

r.post('/businesses/:id/sync-sales',
  allowAdminAsBusiness,
  ensureFn('adminSyncSales', salesSync.adminSyncSales) 
);
module.exports = r;
