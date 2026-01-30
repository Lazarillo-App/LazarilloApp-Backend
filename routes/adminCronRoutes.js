// routes/adminCronRoutes.js
/**
 * 🤖 RUTAS PARA EJECUCIÓN AUTOMÁTICA (CRON)
 *
 * Autenticación: X-Cron-Secret (NO JWT)
 * Propósito: Tareas programadas server-to-server
 *
 * Endpoints disponibles:
 * - POST /api/cron/sync-insumos-hourly      → Sincroniza insumos de todos los negocios
 * - POST /api/cron/sync-articles-hourly     → Sincroniza artículos/menú de todos los negocios
 * - POST /api/cron/sync-sales-daily         → Sincroniza ventas del día anterior
 * - POST /api/cron/backfill-30d             → Re-sincroniza últimos 30 días de ventas
 * - POST /api/cron/backfill-7d              → Re-sincroniza últimos 7 días de ventas
 * - POST /api/cron/sync-one/:businessId     → Sync de ventas para un negocio (debug)
 * - GET  /api/cron/health                   → Salud
 */

const router = require('express').Router();
const pool = require('../config/db');

// Policies
const { syncInsumosAllBusinesses } = require('../services/sync/insumosSyncPolicy');
const { syncArticlesAllBusinesses } = require('../services/sync/articlesSyncPolicy');

// Ventas (policy existente)
const { runDailyAuto, ensureInitialBackfillOnce } = require('../services/salesSyncPolicy');

/* ==================== MIDDLEWARE DE AUTENTICACIÓN ==================== */

function verifyCronSecret(req, res, next) {
  const secret = req.headers['x-cron-secret'];
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret) {
    console.error('⚠️  [cron] CRON_SECRET no configurado en .env');
    return res.status(500).json({
      ok: false,
      error: 'CRON_SECRET not configured'
    });
  }

  if (secret !== expectedSecret) {
    console.warn('⚠️  [cron] Intento de acceso no autorizado');
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized: Invalid X-Cron-Secret'
    });
  }

  next();
}

router.use(verifyCronSecret);

/* ==================== HELPERS ==================== */

async function listBusinessesWithMaxiConfigured() {
  const { rows } = await pool.query(`
    SELECT id
    FROM app_businesses
    WHERE (props->'maxi'->>'email') IS NOT NULL
      AND (
        (props->'maxi'->>'codcli') IS NOT NULL
        OR (props->'maxi'->>'cod_cli') IS NOT NULL
      )
      AND (
        props->'maxi' ? 'pass_enc'
        OR props->'maxi' ? 'pass'
        OR props->'maxi' ? 'password'
      )
      AND deleted_at IS NULL
    ORDER BY id
  `);

  return rows.map(r => Number(r.id)).filter(n => Number.isFinite(n) && n > 0);
}

/* ==================== ENDPOINTS: INSUMOS ==================== */

router.post('/sync-insumos-hourly', async (req, res) => {
  console.log('🤖 [cron] Ejecutando: sync-insumos-hourly');

  try {
    // pasamos req para soportar X-Maxi-Token en debug si lo usás
    const results = await syncInsumosAllBusinesses({ req });

    return res.json({
      ok: true,
      message: 'Insumos sincronizados',
      ...results
    });
  } catch (err) {
    console.error('❌ [cron] Error en sync-insumos-hourly:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ==================== ENDPOINTS: ARTÍCULOS ==================== */

router.post('/sync-articles-hourly', async (req, res) => {
  console.log('🤖 [cron] Ejecutando: sync-articles-hourly');

  try {
    const results = await syncArticlesAllBusinesses({ req });

    return res.json({
      ok: true,
      message: 'Artículos sincronizados',
      ...results
    });
  } catch (err) {
    console.error('❌ [cron] Error en sync-articles-hourly:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ==================== ENDPOINTS: VENTAS ==================== */

/**
 * POST /api/cron/sync-sales-daily
 * Corre la sync diaria (por negocio) según policy.
 */
router.post('/sync-sales-daily', async (req, res) => {
  console.log('🤖 [cron] Ejecutando: sync-sales-daily');

  try {
    const businessIds = await listBusinessesWithMaxiConfigured();

    const details = [];
    let ok = 0, fail = 0;

    // En serie (menos locks/choques)
    for (const businessId of businessIds) {
      try {
        const detail = await runDailyAuto({ businessId, req });
        details.push({ businessId, ok: true, detail });
        ok++;
      } catch (e) {
        details.push({ businessId, ok: false, error: e?.message });
        fail++;
      }
    }

    return res.json({
      ok: true,
      ran: businessIds.length,
      ok_count: ok,
      fail_count: fail,
      details
    });
  } catch (err) {
    console.error('❌ [cron] Error en sync-sales-daily:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/cron/backfill-30d
 * Fuerza backfill inicial/una vez por negocio (windowDays=30).
 */
router.post('/backfill-30d', async (req, res) => {
  console.log('🤖 [cron] Ejecutando: backfill-30d');

  try {
    const businessIds = await listBusinessesWithMaxiConfigured();

    const details = [];
    let ok = 0, fail = 0;

    for (const businessId of businessIds) {
      try {
        const detail = await ensureInitialBackfillOnce({ businessId, windowDays: 30 });
        details.push({ businessId, ok: true, detail });
        ok++;
      } catch (e) {
        details.push({ businessId, ok: false, error: e?.message });
        fail++;
      }
    }

    return res.json({ ok: true, ran: businessIds.length, ok_count: ok, fail_count: fail, details });
  } catch (err) {
    console.error('❌ [cron] Error en backfill-30d:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/cron/backfill-7d
 * Fuerza backfill inicial/una vez por negocio (windowDays=7).
 */
router.post('/backfill-7d', async (req, res) => {
  console.log('🤖 [cron] Ejecutando: backfill-7d');

  try {
    const businessIds = await listBusinessesWithMaxiConfigured();

    const details = [];
    let ok = 0, fail = 0;

    for (const businessId of businessIds) {
      try {
        const detail = await ensureInitialBackfillOnce({ businessId, windowDays: 7 });
        details.push({ businessId, ok: true, detail });
        ok++;
      } catch (e) {
        details.push({ businessId, ok: false, error: e?.message });
        fail++;
      }
    }

    return res.json({ ok: true, ran: businessIds.length, ok_count: ok, fail_count: fail, details });
  } catch (err) {
    console.error('❌ [cron] Error en backfill-7d:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/cron/sync-one/:businessId
 * Debug: correr ventas para un negocio puntual.
 */
router.post('/sync-one/:businessId', async (req, res) => {
  const businessId = Number(req.params.businessId);
  console.log(`🤖 [cron] Ejecutando: sync-one para business ${businessId}`);

  if (!Number.isFinite(businessId) || businessId <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_business_id' });
  }

  try {
    const detail = await runDailyAuto({ businessId, req });
    return res.json({ ok: true, businessId, detail });
  } catch (err) {
    console.error(`❌ [cron] Error en sync-one (${businessId}):`, err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ==================== ENDPOINT DE SALUD ==================== */

router.get('/health', (req, res) => {
  return res.json({
    ok: true,
    message: 'Cron service is running',
    timestamp: new Date().toISOString(),
    endpoints: [
      'POST /api/cron/sync-insumos-hourly',
      'POST /api/cron/sync-articles-hourly',
      'POST /api/cron/sync-sales-daily',
      'POST /api/cron/backfill-30d',
      'POST /api/cron/backfill-7d',
      'POST /api/cron/sync-one/:businessId'
    ]
  });
});

module.exports = router;
