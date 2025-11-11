// routes/businessAdminRoutes.js
const express = require('express');
const r = express.Router();
const pool = require('../config/db');

const { authRequired }   = require('../middleware/authMiddleware');
const { loadActiveBusiness } = require('../middleware/activeBusiness');
const { requireOwner, requireManager } = require('../middleware/requireBizRole');

r.use(authRequired, loadActiveBusiness);

// Invitar miembro (solo owner)
r.post('/members/invite', requireOwner, async (req, res, next) => {
  try {
    const businessId = req.business.id;
    const { userId, role } = req.body; // role ∈ {'owner','manager','staff','viewer'}

    if (!['owner','manager','staff','viewer'].includes(role)) {
      return res.status(400).json({ error: 'invalid_role' });
    }

    await pool.query(
      `INSERT INTO app_memberships (business_id, user_id, role)
       VALUES ($1,$2,$3)
       ON CONFLICT (business_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [businessId, userId, role]
    );

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Catálogo: manager+ (manager/owner)
r.post('/catalog/upsert', requireManager, async (req, res, next) => {
  try {
    // ... tu lógica de catálogo
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = r;
