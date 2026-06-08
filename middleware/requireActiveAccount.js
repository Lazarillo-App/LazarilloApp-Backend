// middleware/requireActiveAccount.js
// Verifica que el usuario tenga cuenta activa (active o trial vigente)
// Se aplica DESPUÉS de authRequired en las rutas protegidas
'use strict';

const pool = require('../config/db');

const PUBLIC_PATHS = [
  '/api/auth/',
  '/api/access/',
  '/api/admin/',
  '/health',
];

async function requireActiveAccount(req, res, next) {
  // Usuarios de servicio o app_admin no necesitan verificación
  if (req.isService || req.user?.role === 'app_admin') return next();

  // Paths públicos (login, register, redimir cupón) pasan siempre
  const path = req.path || req.originalUrl || '';
  if (PUBLIC_PATHS.some(p => path.startsWith(p))) return next();

  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  try {
    const { rows } = await pool.query(
      `SELECT account_status, trial_ends_at, subscription_ends_at
         FROM app_users WHERE id = $1 LIMIT 1`,
      [userId]
    );

    const u = rows[0];
    if (!u) return res.status(401).json({ error: 'user_not_found' });

    const now = new Date();
    let status = u.account_status;

    // Auto-vencer
    if (status === 'trial' && u.trial_ends_at && new Date(u.trial_ends_at) < now) {
      status = 'expired';
      await pool.query(
        `UPDATE app_users SET account_status = 'expired', updated_at = NOW() WHERE id = $1`,
        [userId]
      ).catch(() => {});
    }
    if (status === 'active' && u.subscription_ends_at && new Date(u.subscription_ends_at) < now) {
      status = 'expired';
      await pool.query(
        `UPDATE app_users SET account_status = 'expired', updated_at = NOW() WHERE id = $1`,
        [userId]
      ).catch(() => {});
    }

    if (status === 'active' || status === 'trial') return next();

    // Cuenta no activa — devolver el estado para que el front muestre la pantalla correcta
    return res.status(403).json({
      error: 'account_inactive',
      account_status: status,
      // trial_ends_at para mostrar "tu demo venció el..."
      trial_ends_at: u.trial_ends_at || null,
    });

  } catch (e) {
    console.error('[requireActiveAccount]', e);
    return res.status(500).json({ error: 'internal' });
  }
}

module.exports = requireActiveAccount;