// scripts/cron.js
require('dotenv').config();
const cron  = require('node-cron');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const {
  DATABASE_URL,
  SERVICE_BEARER, // JWT de un usuario del sistema (o token de servicio) con permiso de sync
  CRON_TZ = 'America/Argentina/Buenos_Aires',
  BASE_URL_INTERNAL, // ej: https://lazarilloapp-backend.onrender.com
} = process.env;

if (!DATABASE_URL)     { console.error('[cron] Falta DATABASE_URL');     process.exit(1); }
if (!SERVICE_BEARER)   { console.error('[cron] Falta SERVICE_BEARER');   process.exit(1); }
if (!BASE_URL_INTERNAL){ console.error('[cron] Falta BASE_URL_INTERNAL');process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL });

function pad2(n){ return String(n).padStart(2,'0'); }
function ymdUTC(d){ return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`; }
function at00UTC(d){ return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function addDays(d,n){ return new Date(d.getTime() + n*86400000); }

// ───────────────── helpers DB ─────────────────
async function listBusinessesWithMaxi() {
  const q = `
    SELECT id
      FROM app_businesses
     WHERE (props->'maxi'->>'email')   IS NOT NULL
       AND (props->'maxi'->>'codcli')  IS NOT NULL
       AND (
            props->'maxi' ? 'pass_enc'
         OR props->'maxi' ? 'pass'
         OR props->'maxi' ? 'password'
       )
     ORDER BY id
  `;
  const { rows } = await pool.query(q);
  return rows.map(r => Number(r.id)).filter(Number.isFinite);
}

// ─────────────── llamada con reintentos ───────────────
async function callWithRetries(url, init, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init);
      const text = await r.text().catch(() => '');
      let json; try { json = text ? JSON.parse(text) : null; } catch {}
      if (r.ok) return { r, json, text };
      // 5xx/429 → backoff y reintento
      if ([429,500,502,503,504].includes(r.status) && i < tries - 1) {
        await new Promise(res => setTimeout(res, 400 * (i + 1) ** 2));
        continue;
      }
      const msg = json?.message || json?.error || r.statusText || text;
      throw new Error(`${r.status}: ${msg}`);
    } catch (e) {
      lastErr = e;
      // backoff antes del próximo intento
      if (i < tries - 1) {
        await new Promise(res => setTimeout(res, 400 * (i + 1) ** 2));
      }
    }
  }
  throw lastErr;
}

// ───────────────── sync de AYER ────────────────
async function syncYesterday(businessId) {
  const todayUTC = at00UTC(new Date());
  const y = addDays(todayUTC, -1);
  const from = ymdUTC(y);
  const to   = ymdUTC(y);

  const url = `${BASE_URL_INTERNAL.replace(/\/+$/,'')}/api/businesses/${businessId}/sync-sales?from=${from}&to=${to}`;

  const { json } = await callWithRetries(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_BEARER}`,
      'X-Business-Id': String(businessId),
    },
  });

  // logs amigables
  const counts = json?.counts || json?.sales?.counts || {};
  const upserted = counts.upserted ?? json?.upserted ?? 0;
  const updated  = counts.updated  ?? json?.updated  ?? 0;
  const raw      = counts.raw      ?? json?.raw      ?? 0;

  console.log(`[cron] OK biz=${businessId} ${from}→${to} upserted=${upserted} updated=${updated} raw=${raw}`);
}

// ───────────── batch sobre todos los negocios ─────────────
async function runDailyJob() {
  try {
    const ids = await listBusinessesWithMaxi();
    if (!ids.length) {
      console.log('[cron] No hay negocios con credenciales Maxi.');
      return;
    }
    console.log(`[cron] Iniciando sync diario de AYER. Negocios: ${ids.join(', ')}`);

    const CONC = 3;
    let idx = 0;
    async function worker() {
      while (idx < ids.length) {
        const my = idx++;
        const bizId = ids[my];
        try {
          await syncYesterday(bizId);
        } catch (err) {
          console.error(`[cron] ERROR biz=${bizId}:`, err?.message || err);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, ids.length) }, worker));
    console.log('[cron] Sync diario finalizado');
  } catch (err) {
    console.error('[cron] Error general:', err?.message || err);
  }
}

// ───────────────── programación ─────────────────
// todos los días 03:00 hora local (negocio)
cron.schedule('0 3 * * *', runDailyJob, { timezone: CRON_TZ });

// modo manual: `node scripts/cron.js run-now`
if (process.argv[2] === 'run-now') {
  runDailyJob().then(() => process.exit(0));
}
