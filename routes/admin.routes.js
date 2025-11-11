// routes/admin.routes.js
const express = require('express');
const r = express.Router();

const adminCtrl = require('../controllers/adminController');
const { authRequired } = require('../middleware/authMiddleware');
const requireAppAdmin = require('../middleware/requireAppAdmin');

// ➕ import del servicio de catálogo
const { syncCatalogFromMenu } = require('../services/catalogSyncService');

// ➕ import del helper de agregados
const pool = require('../config/db');
const { upsertDailyAggregates } = require('../services/salesStore');

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
    const { listmode, list, id_tienda } = req.query;
    const out = await syncCatalogFromMenu({ businessId, req, listmode, list, id_tienda });
    res.json({ ok: true, business_id: businessId, ...out });
  } catch (e) { next(e); }
});

// 🔧 Rebuild de agregados por rango (uso manual desde panel)
r.post('/rebuild-daily', async (req, res, next) => {
  try {
    const biz  = Number(req.query.biz  ?? req.body?.biz);
    const from =        req.query.from ?? req.body?.from;
    const to   =        req.query.to   ?? req.body?.to;

    if (!Number.isFinite(biz) || !from || !to) {
      return res.status(400).json({ error: 'Parámetros requeridos: biz, from, to (YYYY-MM-DD)' });
    }

    await upsertDailyAggregates(pool, biz, from, to);
    return res.json({ ok: true, business_id: biz, from, to });
  } catch (e) { next(e); }
});

module.exports = r;
