// services/cron.js
const cron = require('node-cron');
const pool = require('../config/db');
const { runDailyAuto, ensureInitialBackfillOnce } = require('./salesSyncPolicy');
const { abrirCorrida, ejecutarCorrida } = require('./gestion/render/sync');
const { recetasDelReloj } = require('./recetasDesdeKit');

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
  // Render puede tener el nombre con otras mayúsculas: no apagar la ingesta por eso.
  const nombre = (process.env.RENDER_SERVICE_NAME || '').trim().toLowerCase();
  return nombre === servicio.trim().toLowerCase();
}

/**
 * Recetas desde el kit (Diego, 06/11/2026): cada hora, minuto 20 (después de la ingesta de
 * Balance del minuto 5), corre los pipelines de ventas (12) y compras/pagos (25/80) de los
 * negocios cuyo kit subió algo nuevo. Ver services/recetasDesdeKit.js.
 * - RECETAS_KIT_CRON=1 / 0 → fuerza encenderlo / apagarlo en este servicio.
 *   Sin la variable, corre donde corre la ingesta de gestion (gestionCronHabilitado).
 * - CRON_RECETAS_KIT_SCHEDULE → default "20 * * * *".
 * Si corre en dos servicios con la misma base no se pisa: candado por negocio en la base y
 * solo corre si hay cargas del kit posteriores a la última pasada.
 */
let recetasKitStarted = false;

function startRecetasKitCron() {
  if (recetasKitStarted) return;
  recetasKitStarted = true;
  const forzado = process.env.RECETAS_KIT_CRON;
  const habilitado = forzado === '1' || (forzado !== '0' && gestionCronHabilitado());
  if (!habilitado) {
    console.log(`[cron] recetas desde el kit deshabilitado en este servicio (${process.env.RENDER_SERVICE_NAME || 'local'})`);
    return;
  }
  const tz = process.env.CRON_TZ || 'America/Argentina/Buenos_Aires';
  const expr = process.env.CRON_RECETAS_KIT_SCHEDULE || '20 * * * *';
  console.log(`[cron] recetas desde el kit habilitado. TZ=${tz} schedule=${expr}`);
  cron.schedule(expr, async () => {
    try {
      await recetasDelReloj();
    } catch (e) {
      console.error('[cron] ❌ error en recetas desde el kit:', e.message);
    }
  }, { timezone: tz });
}

/**
 * Mercado Pago todos los días (Diego 14/11/2026): cada cuenta conectada trae cobros, pagos,
 * devoluciones y el reporte de los últimos días (services/mercadopagoDiario.js).
 * - MP_CRON=1 / 0 → fuerza encenderlo / apagarlo. Sin la variable, corre donde corre la ingesta
 *   de gestion (un solo servicio: testing y producción comparten la base).
 * - CRON_MP_SCHEDULE → default "40 6 * * *" (06:40, antes de que abra la administración).
 */
let mpStarted = false;

function startMercadoPagoCron() {
  if (mpStarted) return;
  mpStarted = true;
  const forzado = process.env.MP_CRON;
  const habilitado = forzado === '1' || (forzado !== '0' && gestionCronHabilitado());
  if (!habilitado) {
    console.log(`[cron] Mercado Pago diario deshabilitado en este servicio (${process.env.RENDER_SERVICE_NAME || 'local'})`);
    return;
  }
  const tz = process.env.CRON_TZ || 'America/Argentina/Buenos_Aires';
  const expr = process.env.CRON_MP_SCHEDULE || '40 6 * * *';
  console.log(`[cron] Mercado Pago diario habilitado. TZ=${tz} schedule=${expr}`);
  cron.schedule(expr, async () => {
    try {
      await require('./mercadopagoDiario').corridaDiaria();
    } catch (e) {
      console.error('[cron] ❌ error en Mercado Pago diario:', e.message);
    }
  }, { timezone: tz });
}

/**
 * Fudo todas las noches (usuaria 17/11/2026): cada negocio conectado trae sus productos y las ventas
 * cerradas desde el último día completo (menos unos días de repaso) hasta ayer (services/fudoService.js).
 * Es todo servidor a servidor: no depende de ninguna compu del local.
 * - FUDO_CRON=1 / 0 → fuerza encenderlo / apagarlo. Sin la variable, corre donde corre la ingesta
 *   de gestion (un solo servicio: testing y producción comparten la base).
 * - CRON_FUDO_SCHEDULE → default "30 4 * * *" (04:30, con el día anterior ya cerrado).
 */
let fudoStarted = false;

function startFudoCron() {
  if (fudoStarted) return;
  fudoStarted = true;
  const forzado = process.env.FUDO_CRON;
  const habilitado = forzado === '1' || (forzado !== '0' && gestionCronHabilitado());
  if (!habilitado) {
    console.log(`[cron] Fudo diario deshabilitado en este servicio (${process.env.RENDER_SERVICE_NAME || 'local'})`);
    return;
  }
  const tz = process.env.CRON_TZ || 'America/Argentina/Buenos_Aires';
  const expr = process.env.CRON_FUDO_SCHEDULE || '30 4 * * *';
  console.log(`[cron] Fudo diario habilitado. TZ=${tz} schedule=${expr}`);
  cron.schedule(expr, async () => {
    try {
      await require('./fudoService').corridaDiaria();
    } catch (e) {
      console.error('[cron] ❌ error en Fudo diario:', e.message);
    }
  }, { timezone: tz });
}

/**
 * Wona todas las noches (usuaria 25/11/2026): cada negocio conectado trae ventas, turnos, buffet y
 * compras de su sede de Wona (services/wonaService.js). Servidor a servidor, solo lectura.
 * - WONA_CRON=1 / 0 → fuerza encenderlo / apagarlo. Sin la variable, corre donde corre la ingesta.
 * - CRON_WONA_SCHEDULE → default "45 4 * * *" (04:45).
 */
let wonaStarted = false;

function startWonaCron() {
  if (wonaStarted) return;
  wonaStarted = true;
  const forzado = process.env.WONA_CRON;
  const habilitado = forzado === '1' || (forzado !== '0' && gestionCronHabilitado());
  if (!habilitado) {
    console.log(`[cron] Wona diario deshabilitado en este servicio (${process.env.RENDER_SERVICE_NAME || 'local'})`);
    return;
  }
  const tz = process.env.CRON_TZ || 'America/Argentina/Buenos_Aires';
  const expr = process.env.CRON_WONA_SCHEDULE || '45 4 * * *';
  console.log(`[cron] Wona diario habilitado. TZ=${tz} schedule=${expr}`);
  cron.schedule(expr, async () => {
    try {
      await require('./wonaService').corridaDiaria();
    } catch (e) {
      console.error('[cron] ❌ error en Wona diario:', e.message);
    }
  }, { timezone: tz });
}

/**
 * Servicios por hora (Diego 20/11/2026): todos los días recalcula cada ancla y su familia y avisa
 * si los costos subieron 5 % desde el último aumento o si bajó el uso (services/servicioAvisos.js).
 * - SERVICIOS_CRON=1 / 0 → fuerza encenderlo / apagarlo. Sin la variable, corre donde corre la
 *   ingesta de gestion (un solo servicio: testing y producción comparten la base).
 * - CRON_SERVICIOS_SCHEDULE → default "50 6 * * *" (después de la ingesta de la madrugada).
 */
let serviciosStarted = false;

function startServiciosCron() {
  if (serviciosStarted) return;
  serviciosStarted = true;
  const forzado = process.env.SERVICIOS_CRON;
  const habilitado = forzado === '1' || (forzado !== '0' && gestionCronHabilitado());
  if (!habilitado) {
    console.log(`[cron] servicios por hora deshabilitado en este servicio (${process.env.RENDER_SERVICE_NAME || 'local'})`);
    return;
  }
  const tz = process.env.CRON_TZ || 'America/Argentina/Buenos_Aires';
  const expr = process.env.CRON_SERVICIOS_SCHEDULE || '50 6 * * *';
  console.log(`[cron] servicios por hora habilitado. TZ=${tz} schedule=${expr}`);
  cron.schedule(expr, async () => {
    try {
      await require('./servicioAvisos').revisarServicios();
    } catch (e) {
      console.error('[cron] ❌ error en servicios por hora:', e.message);
    }
  }, { timezone: tz });
}

function startGestionCron() {
  if (gestionStarted) return;
  gestionStarted = true;

  // Independiente de la ingesta: tiene su propia llave (RECETAS_KIT_CRON).
  startRecetasKitCron();
  // Mercado Pago diario: su propia llave (MP_CRON).
  startMercadoPagoCron();
  // Fudo diario: su propia llave (FUDO_CRON).
  startFudoCron();
  // Wona diario: su propia llave (WONA_CRON).
  startWonaCron();
  // Servicios por hora: su propia llave (SERVICIOS_CRON).
  startServiciosCron();

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
    // Aumentos de la carta (informe 12): una vez por día, después de la lectura.
    await require('./gestion/render/aumentos').detectarAumentosDelDia();
  }, { timezone: tz });
}

module.exports = { startCron, startGestionCron, startRecetasKitCron, startMercadoPagoCron, startFudoCron, startServiciosCron, syncAllBusinessesDaily, ensureBackfillAll };
