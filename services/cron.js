// services/cron.js
const cron = require('node-cron');
const pool = require('../config/db');
const { runDailyAuto, ensureInitialBackfillOnce } = require('./salesSyncPolicy');
const { abrirCorrida, ejecutarCorrida } = require('./gestion/render/sync');

let started = false;

function parseBool(v) {
  return String(v || '').toLowerCase() === '1' || String(v || '').toLowerCase() === 'true';
}

/**
 * Corre la sync diaria para TODOS los negocios con credenciales Maxi válidas.
 * Usa la misma query de adminCronRoutes.
 */
async function syncAllBusinessesDaily() {
  const { rows } = await pool.query(`
    SELECT id
    FROM app_businesses
    WHERE (props->'maxi'->>'email') IS NOT NULL
      AND (props->'maxi'->>'codcli') IS NOT NULL
      AND (props->'maxi' ? 'pass_enc' OR props->'maxi' ? 'pass' OR props->'maxi' ? 'password')
  `);

  let ok = 0, fail = 0;
  const details = [];

  for (const b of rows) {
    try {
      // incremental: si no hay backfill inicial, la policy lo hace
      const data = await runDailyAuto({ businessId: b.id });
      details.push({ id: b.id, ok: true, detail: data });
      ok++;
    } catch (e) {
      details.push({ id: b.id, ok: false, error: e?.message });
      fail++;
    }
  }

  console.log(`[cron] syncAllBusinessesDaily => ran=${rows.length} ok=${ok} fail=${fail}`);
  if (process.env.LOG_CRON_DETAILS === '1') {
    console.log('[cron] details:', JSON.stringify(details, null, 2));
  }
  return { ran: rows.length, ok, fail, details };
}

/**
 * Backfill inicial manual (por si querés dispararlo desde cron al amanecer)
 */
async function ensureBackfillAll() {
  const { rows } = await pool.query(`
    SELECT id
    FROM app_businesses
    WHERE (props->'maxi'->>'email') IS NOT NULL
      AND (props->'maxi'->>'codcli') IS NOT NULL
      AND (props->'maxi' ? 'pass_enc' OR props->'maxi' ? 'pass' OR props->'maxi' ? 'password')
  `);

  for (const b of rows) {
    try {
      await ensureInitialBackfillOnce({ businessId: b.id });
    } catch (e) {
      console.warn('[cron] ensureBackfillAll error:', b.id, e.message);
    }
  }
}

/**
 * Arranca cron según .env
 * - CRON_ENABLED=1 para habilitar
 * - CRON_TZ=America/Argentina/Buenos_Aires
 * - CRON_SALES_SCHEDULE (CRON): ej "15 4 * * *" → 04:15 todos los días
 */
function startCron() {
  if (started) return;
  started = true;

  const enabled = parseBool(process.env.CRON_ENABLED);
  if (!enabled) {
    console.log('[cron] deshabilitado (CRON_ENABLED != 1)');
    return;
  }

  const tz = process.env.CRON_TZ || 'America/Argentina/Buenos_Aires';
  const salesExpr = process.env.CRON_SALES_SCHEDULE || '15 4 * * *'; // 04:15 AM

  console.log(`[cron] habilitado. TZ=${tz} sales=${salesExpr}`);

  // Ventas diarias
  cron.schedule(salesExpr, async () => {
    console.log('[cron] ⏰ Ejecutando syncAllBusinessesDaily…');
    try {
      await syncAllBusinessesDaily();
    } catch (e) {
      console.error('[cron] ❌ error en syncAllBusinessesDaily:', e.message);
    }
  }, { timezone: tz });

  // (Opcional) Backfill inicial para todos a las 04:05 una sola vez si querés
  if (parseBool(process.env.CRON_BACKFILL_ALL_ONCE)) {
    cron.schedule('5 4 * * *', async () => {
      console.log('[cron] ⏰ ensureBackfillAll…');
      try {
        await ensureBackfillAll();
      } catch (e) {
        console.error('[cron] ❌ error en ensureBackfillAll:', e.message);
      }
    }, { timezone: tz });
  }
}

/**
 * Ingesta de gestion desde el kit (port de lazarillo_gestion), cada hora.
 *
 * No depende de CRON_ENABLED: en prod está en 0 (los crons de ventas/insumos los
 * dispara el Cron Job de Render por HTTP) y el back de pruebas usa la MISMA base,
 * así que tiene que correr en un solo servicio. Por defecto corre solo en el back
 * de producción (RENDER_SERVICE_NAME lo pone Render en cada servicio).
 * - GESTION_CRON=1 / 0 → fuerza encenderla / apagarla en cualquier servicio
 * - GESTION_CRON_SERVICE → nombre del servicio donde corre (default LazarilloApp-Backend)
 * - CRON_GESTION_SCHEDULE (CRON) → default "5 * * * *": minuto 5 de cada hora, para no
 *   coincidir con el Cron Job de insumos (minuto 0). Sin novedades en el kit tarda segundos.
 * El candado de gestion_render_corridas evita duplicarla si además se dispara
 * POST /api/cron/gestion-ingesta.
 */
let gestionStarted = false;

function gestionCronHabilitado() {
  const forzado = process.env.GESTION_CRON;
  if (forzado === '1' || forzado === '0') return forzado === '1';
  const servicio = process.env.GESTION_CRON_SERVICE || 'LazarilloApp-Backend';
  return process.env.RENDER_SERVICE_NAME === servicio;
}

function startGestionCron() {
  if (gestionStarted) return;
  gestionStarted = true;

  if (!gestionCronHabilitado()) {
    console.log(`[cron] ingesta de gestion deshabilitada en este servicio (${process.env.RENDER_SERVICE_NAME || 'local'})`);
    return;
  }

  const tz = process.env.CRON_TZ || 'America/Argentina/Buenos_Aires';
  const expr = process.env.CRON_GESTION_SCHEDULE || '5 * * * *';
  console.log(`[cron] ingesta de gestion habilitada. TZ=${tz} schedule=${expr}`);

  cron.schedule(expr, async () => {
    console.log('[cron] ⏰ Ejecutando ingesta de gestion…');
    try {
      const id = await abrirCorrida('cron');
      if (id == null) {
        console.log('[cron] ingesta de gestion ya en curso, se saltea');
        return;
      }
      await ejecutarCorrida(id, 'cron');
    } catch (e) {
      console.error('[cron] ❌ error en ingesta de gestion:', e.message);
    }
  }, { timezone: tz });
}

module.exports = { startCron, startGestionCron, syncAllBusinessesDaily, ensureBackfillAll };
