// scripts/cron.js
require('dotenv').config();
const cron  = require('node-cron');
const fetch = require('node-fetch');
const { Pool } = require('pg');

// ===== Config =====
const {
  DATABASE_URL,
  SERVICE_BEARER,              // JWT del servicio (se usa como Authorization Bearer)
  CRON_TZ = 'America/Argentina/Buenos_Aires', // zona horaria del negocio
  BASE_URL_INTERNAL,           // ej: https://lazarilloapp-backend.onrender.com
} = process.env;

if (!DATABASE_URL) {
  console.error('[cron] Faltan env DATABASE_URL');
  process.exit(1);
}
if (!SERVICE_BEARER) {
  console.error('[cron] Faltan env SERVICE_BEARER (Bearer JWT de servicio interno)');
  process.exit(1);
}
if (!BASE_URL_INTERNAL) {
  console.error('[cron] Faltan env BASE_URL_INTERNAL (url pública del backend)');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

function pad2(n){ return String(n).padStart(2,'0'); }
function ymdUTC(d){ return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`; }
function at00UTC(d){ return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function addDays(d,n){ return new Date(d.getTime() + n*86400000); }

// Lista de negocios que tienen credenciales Maxi configuradas
async function listBusinessesWithMaxi() {
  // Ajustá el nombre de tabla/columna si difiere
  const q = `
    SELECT id
      FROM businesses
     WHERE is_active = true
       AND (props -> 'maxi') IS NOT NULL
     ORDER BY id
  `;
  const { rows } = await pool.query(q);
  return rows.map(r => Number(r.id)).filter(Number.isFinite);
}

// Ejecuta el sync para [ayer, ayer] en un negocio
async function syncYesterday(businessId) {
  const todayUTC = at00UTC(new Date());
  const yesterday = addDays(todayUTC, -1);
  const from = ymdUTC(yesterday);
  const to   = ymdUTC(yesterday);

  const url = `${BASE_URL_INTERNAL.replace(/\/+$/,'')}/api/businesses/${businessId}/sync-sales?from=${from}&to=${to}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_BEARER}`,
      'X-Business-Id': String(businessId), // por si tu middleware lo usa
    },
  });

  const text = await r.text().catch(() => '');
  let json; try { json = JSON.parse(text); } catch { json = null; }

  if (!r.ok) {
    const m = json?.message || json?.error || r.statusText || text;
    throw new Error(`[cron] sync-sales ${businessId} ${from}→${to} ${r.status}: ${m}`);
  }

  const counts = json?.sales?.counts || {};
  console.log(`[cron] OK business=${businessId} ${from}→${to} upserted=${counts.upserted ?? 0} updated=${counts.updated ?? 0} raw=${counts.raw ?? 0}`);
}

// Corre el job sobre todos los negocios (con concurrencia amable)
async function runDailyJob() {
  try {
    const ids = await listBusinessesWithMaxi();
    console.log(`[cron] Iniciando sync diario. Businesses: ${ids.join(', ') || '(ninguno)'}`);

    const CONC = 3;
    let idx = 0;
    async function worker() {
      while (idx < ids.length) {
        const my = idx++;
        const bizId = ids[my];
        try {
          await syncYesterday(bizId);
        } catch (err) {
          console.error(err?.message || err);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, ids.length) }, worker));
    console.log('[cron] Sync diario finalizado');
  } catch (err) {
    console.error('[cron] Error general:', err?.message || err);
  }
}

// ───────────────────────────────────────────────────────────────
// Programa: todos los días a las 03:00 (zona CRON_TZ)
cron.schedule('0 3 * * *', runDailyJob, { timezone: CRON_TZ });

// Si querés probar a mano: `node scripts/cron.js run-now`
if (process.argv[2] === 'run-now') {
  runDailyJob().then(() => process.exit(0));
}
