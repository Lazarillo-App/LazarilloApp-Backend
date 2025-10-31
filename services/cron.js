// services/cron.js
const cron = require('node-cron');
const pool = require('../config/db');
const { runDailyAuto, ensureInitialBackfillOnce } = require('./salesSyncPolicy');

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

module.exports = { startCron, syncAllBusinessesDaily, ensureBackfillAll };
