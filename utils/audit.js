// utils/audit.js
// Carga flexible del "db": intenta varias rutas y, si no existe, crea un Pool local.
let db = null;
(function resolveDb() {
  const tryPaths = [
    '../config/db',
  ];
  for (const p of tryPaths) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const mod = require(p);
      if (mod && typeof mod.query === 'function') { db = mod; return; }
      if (mod && mod.pool && typeof mod.pool.query === 'function') { db = mod.pool; return; }
    } catch (_) {}
  }
  // Fallback: construye un Pool mínimo con envs
  const { Pool } = require('pg');
  const opts = { connectionString: process.env.DATABASE_URL };
  // Compatibilidad con Render/local sin SSL o con SSL
  if (String(process.env.PGSSLMODE || '').toLowerCase() === 'require') {
    opts.ssl = { rejectUnauthorized: false };
  }
  const pool = new Pool(opts);
  db = { query: (text, params) => pool.query(text, params) };
})();

/**
 * Registra una acción de auditoría (no rompe la request si falla).
 * @param {number|null} actorUserId
 * @param {string} action          // ej: 'user.update'
 * @param {string} entityType      // ej: 'users'
 * @param {string|null} entityId   // ej: '42'
 * @param {object|null} meta       // datos adicionales
 */
async function logAdmin(actorUserId, action, entityType, entityId = null, meta = null) {
  try {
    await db.query(
      `INSERT INTO audit_logs(actor_user_id, action, entity_type, entity_id, meta)
       VALUES ($1,$2,$3,$4,$5)`,
      [actorUserId || null, action, entityType, entityId, meta ? JSON.stringify(meta) : null]
    );
  } catch (e) {
    console.error('[audit] insert failed:', e?.message || e);
  }
}

module.exports = { logAdmin };
