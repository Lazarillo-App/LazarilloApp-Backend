// scripts/fetch_menu_to_cache.js
require('dotenv').config();
const crypto = require('crypto');
const { Client } = require('pg');
const fetch = global.fetch || require('node-fetch');

// Usa la misma BASE que tu backend
const BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');

// ---- helpers ----
function sha256(obj) {
  const s = JSON.stringify(obj);
  return crypto.createHash('sha256').update(s).digest('hex');
}

function jsonParseSafe(x) { try { return JSON.parse(x); } catch { return x; } }

// Trae credenciales Maxi desde app_businesses.props.maxi
async function getMaxiCredsFromDB(pg, bizId) {
  const { rows } = await pg.query(`SELECT props FROM public.app_businesses WHERE id=$1 LIMIT 1`, [bizId]);
  const props = rows[0]?.props || {};
  const mx = props.maxi || {};
  // Si ya guardas la pass cifrada (pass_enc) como en tu backend:
  let password = mx.password || null;
  if (!password && mx.pass_enc) {
    // reusa tu helper de backend sin romper el script:
    const { decryptSecretCompat } = require('../utils/cryptoField');
    password = decryptSecretCompat(mx.pass_enc);
  }
  if (!(mx.email && password && mx.codcli)) {
    throw new Error(`maxi_not_configured: faltan email/password/codcli en props.maxi del business ${bizId}`);
  }
  return { email: mx.email, password, codcli: String(mx.codcli) };
}

// Login a Maxi → tokenAccess
async function maxiLogin({ email, password, codcli }) {
  const r = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email, pass: password, cod_cli: codcli }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.resultCode !== 'SUCCESS' || !j?.content?.tokenAccess) {
    const id = j?.resultId || r.status;
    throw new Error(`maxi_login_failed_${id}`);
  }
  return j.content.tokenAccess;
}

// GET menuextendido
async function fetchMenuExtendido({ token, desde, hasta }) {
  const u = new URL(`${BASE}/menuweb/menuextendido`);
  if (desde) u.searchParams.set('fechaInicio', desde);
  if (hasta) u.searchParams.set('fechaFin', hasta);

  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));

  if (!r.ok || j?.resultCode === 'UNAUTHORIZED_ACCESS') {
    throw new Error(`maxi_fetch_unauthorized_${r.status}`);
  }
  // Maxi a veces devuelve array directo o {content:[...]}
  const payload = Array.isArray(j) ? j : (j?.content ?? []);
  if (!Array.isArray(payload)) return [];
  return payload;
}

// ---- main ----
(async () => {
  const bizId = Number(process.argv[2]);
  const desde = process.argv[3] || '2025-01-01';
  const hasta = process.argv[4] || '2030-01-01';

  if (!Number.isFinite(bizId) || bizId <= 0) {
    console.error('Uso: node scripts/fetch_menu_to_cache.js <BUSINESS_ID> [YYYY-MM-DD desde] [YYYY-MM-DD hasta]');
    process.exit(1);
  }

  const pg = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await pg.connect();

    // Asegura tablas de cache (igual que antes)
    await pg.query(`
      CREATE TABLE IF NOT EXISTS public.maxi_menu_cache (
        id           bigserial PRIMARY KEY,
        business_id  integer      NOT NULL,
        source       text         NOT NULL DEFAULT 'menuweb/menuextendido',
        payload      jsonb        NOT NULL,
        hash         text         NOT NULL,
        updated_at   timestamptz  NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_maxi_menu_cache_biz_hash
        ON public.maxi_menu_cache (business_id, hash);
      CREATE INDEX IF NOT EXISTS ix_maxi_menu_cache_biz_updated
        ON public.maxi_menu_cache (business_id, updated_at DESC);
    `);

    // 1) creds dinámicas desde DB
    const creds = await getMaxiCredsFromDB(pg, bizId);

    // 2) login dinámico
    const token = await maxiLogin(creds);

    // 3) menú
    const payload = await fetchMenuExtendido({ token, desde, hasta });

    // 4) guarda en cache por business
    const hash = sha256(payload);
    await pg.query(`
      INSERT INTO public.maxi_menu_cache (business_id, source, payload, hash)
      VALUES ($1, 'menuweb/menuextendido', $2::jsonb, $3)
      ON CONFLICT (business_id, hash) DO UPDATE
        SET updated_at = NOW()
    `, [bizId, JSON.stringify(payload), hash]);

    console.log(`Menú cacheado: business=${bizId} · items=${payload.length} · hash=${hash.slice(0,10)}…`);
  } catch (e) {
    // intenta loguear JSON legible si el error trae response body
    console.error('ERROR:', e.message || e);
    const extra = jsonParseSafe(e?.response?.data);
    if (extra) console.error('DETAIL:', extra);
    process.exitCode = 1;
  } finally {
    await pg.end().catch(() => {});
  }
})();
