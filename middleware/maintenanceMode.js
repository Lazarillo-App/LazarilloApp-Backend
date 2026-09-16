// middleware/maintenanceMode.js
// Corta con 503 cualquier request bajo /api que no sea de /api/admin (el gate real
// lo da requireAppAdmin) ni /api/auth/login (para que cualquiera pueda autenticarse;
// si no es app_admin, el resto de sus llamadas van a seguir cortando en 503 igual).
// Cachea el flag en memoria del proceso (TTL corto) para no pegarle a la DB en cada request.

const pool = require('../config/db');

const TTL_MS = 5000;
let cache = { value: null, ts: 0 };

async function readFlag() {
  const now = Date.now();
  if (cache.value && (now - cache.ts) < TTL_MS) return cache.value;

  try {
    const { rows } = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'maintenance' LIMIT 1`
    );
    const value = rows[0]?.value || { enabled: false };
    cache = { value, ts: now };
    return value;
  } catch (e) {
    // Si la tabla todavía no existe (script no corrido) u otro error de DB,
    // no bloqueamos la app entera por un problema de infraestructura de este flag.
    console.warn('[maintenanceMode] no se pudo leer platform_settings:', e.message);
    return { enabled: false };
  }
}

function invalidateMaintenanceCache() {
  cache = { value: null, ts: 0 };
}

async function maintenanceMode(req, res, next) {
  const url = req.originalUrl || '';
  if (url.startsWith('/api/admin') || url.startsWith('/api/auth/login')) {
    return next();
  }

  const flag = await readFlag();
  if (flag?.enabled) {
    return res.status(503).json({
      error: 'maintenance',
      message: flag.message || 'La app está en mantenimiento. Volvé a intentarlo en unos minutos.',
    });
  }
  next();
}

module.exports = maintenanceMode;
module.exports.invalidateMaintenanceCache = invalidateMaintenanceCache;
