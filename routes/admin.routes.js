// routes/admin.routes.js
const express = require('express');
const r = express.Router();

const adminCtrl = require('../controllers/adminController');
const { authRequired } = require('../middleware/authMiddleware');
const requireAppAdmin = require('../middleware/requireAppAdmin');

// ➕ import del servicio de catálogo
const { syncCatalogFromMenu } = require('../services/catalogSyncService');

// Todos los endpoints de admin requieren auth + app_admin
r.use(authRequired, requireAppAdmin);

// ----- Admin overview / usuarios -----
r.get('/overview', adminCtrl.overview);
r.get('/users',    adminCtrl.listUsers);
r.patch('/users/:id', adminCtrl.updateUser);
r.delete('/users/:id', adminCtrl.softDeleteUser);
r.post('/users/:id/reset-password', adminCtrl.resetPassword);
r.post('/users/:id/restore', adminCtrl.restoreUser);

// ----- Catálogo (trae desde Maxi y upsertea en app_articles) -----
// POST /api/admin/sync-catalog?businessId=31&listmode=ATOM&list=1,2,3,4&id_tienda=123
r.post('/sync-catalog', async (req, res, next) => {
  try {
    const businessId = Number(req.query.businessId || req.body?.businessId);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ error: 'businessId requerido' });
    }

    const { listmode, list, id_tienda } = req.query; // podés aceptar también por body si querés
    const out = await syncCatalogFromMenu({ businessId, req, listmode, list, id_tienda });
    res.json({ ok: true, business_id: businessId, ...out });
  } catch (e) { next(e); }
});

module.exports = r;

