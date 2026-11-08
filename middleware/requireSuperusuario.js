// middleware/requireSuperusuario.js
// Deja pasar solo a cuentas con app_users.es_superusuario = true.
// Se lee siempre de la base (no del token), así un permiso quitado corta en el acto.
const pool = require('../config/db');

module.exports = async function requireSuperusuario(req, res, next) {
  try {
    const uid = Number(req.user?.id);
    if (!Number.isFinite(uid) || uid <= 0) return res.status(401).json({ error: 'unauthorized' });
    const { rows } = await pool.query(
      'SELECT es_superusuario FROM app_users WHERE id = $1 LIMIT 1', [uid]
    );
    if (rows[0]?.es_superusuario !== true) return res.status(403).json({ error: 'solo_superusuario' });
    next();
  } catch (e) {
    console.error('[requireSuperusuario] error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
