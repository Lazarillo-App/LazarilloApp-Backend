// src/middlewares/loadBusiness.js
/* eslint-disable no-console */
const pool = require('../config/db');

/**
 * Middleware que carga el negocio en req.business
 * usando el :id de la ruta (/api/businesses/:id/...).
 *
 * Requiere que antes ya se haya resuelto req.user (requireAuth).
 */
module.exports = async function loadBusiness(req, res, next) {
  try {
    const rawId =
      req.params.id ||
      req.params.businessId ||
      req.body?.businessId ||
      req.query?.businessId;

    const businessId = Number(rawId);

    if (!Number.isFinite(businessId) || businessId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    // 🟢 Negocio base
    const { rows } = await pool.query(
      `
      SELECT *
      FROM app_businesses
      WHERE id = $1
      `,
      [businessId]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'business_not_found' });
    }

    const biz = rows[0];

    // 🟡 (Opcional) validación de que el usuario tenga acceso al negocio
    // Si tenés tabla app_user_businesses o similar, podés reforzar así:
    //
    // const userId = req.user?.id;
    // if (userId) {
    //   const { rows: relRows } = await pool.query(
    //     `
    //     SELECT 1
    //     FROM app_user_businesses
    //     WHERE user_id = $1 AND business_id = $2
    //     `,
    //     [userId, businessId]
    //   );
    //   if (!relRows.length) {
    //     return res.status(403).json({ ok: false, error: 'forbidden_business' });
    //   }
    // }

    req.business = biz;
    next();
  } catch (e) {
    console.error('loadBusiness error:', e);
    next(e);
  }
};
