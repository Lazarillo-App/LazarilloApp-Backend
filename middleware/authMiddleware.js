// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const SECRET = process.env.JWT_SECRET || 'dev-secret';

module.exports = async function authRequired(req, res, next) {
  try {
    // ---- 1) JWT obligatorio
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'missing_token' });

    let payload;
    try {
      payload = jwt.verify(m[1], SECRET);
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }

    req.user = { id: payload.uid, email: payload.email };

    // ---- 2) Resolver businessId si aplica
    let businessId = Number(req.params?.id);
    if (!Number.isFinite(businessId)) {
      const hdr = req.header('X-Business-Id');
      businessId = Number(hdr);
    }
    if (!Number.isFinite(businessId)) {
      // último recurso: negocio activo del usuario
      const { rows } = await pool.query(
        'SELECT active_business_id FROM app_users WHERE id=$1',
        [req.user.id]
      );
      businessId = Number(rows[0]?.active_business_id);
    }

    // ---- 3) Si hay businessId, validar pertenencia y adjuntar
    if (Number.isFinite(businessId)) {
      const { rows: biz } = await pool.query(
        `SELECT b.*
           FROM app_businesses b
           LEFT JOIN user_businesses ub ON ub.business_id=b.id
          WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2)
          LIMIT 1`,
        [businessId, req.user.id]
      );
      if (!biz.length) {
        // Ocultamos existencia (anti-enumeración). Si preferís, usá 403.
        return res.status(404).json({ error: 'not_found' });
      }
      req.businessId = businessId;
      req.business   = biz[0];
    }

    // Listo
    next();
  } catch (e) {
    console.error('authRequired error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
