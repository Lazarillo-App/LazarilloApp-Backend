// scripts/fetch_menu_cache.js
require('dotenv').config();
const crypto = require('crypto');
const fetch  = require('node-fetch');
const { Client } = require('pg');

// ---------- utils ----------
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => JSON.stringify(k)+':'+stableStringify(obj[k])).join(',')}}`;
}
function stableHash(obj) {
  return crypto.createHash('sha256').update(stableStringify(obj), 'utf8').digest('hex');
}

/**
 * Normaliza el payload del menú:
 * - Acepta payload plano o con payload.content
 * - Cada elemento puede venir como { raw: {...rubro...}, ... } → se usa elem.raw
 * - Garantiza un array de rubros con forma consistente:
 *   [{ id, nombre, ... , articulos:[], subrubros:[{ id,nombre,..., articulos:[] }, ...] }, ...]
 */
function normalizeMenuPayload(payload) {
  const top = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.content) ? payload.content : []);

  const flat = top.map(e => {
    const r = (e && typeof e === 'object' && e.raw && typeof e.raw === 'object') ? e.raw : e;
    // Asegurar arrays consistentes
    const articulos  = Array.isArray(r?.articulos) ? r.articulos : [];
    const subrubros  = Array.isArray(r?.subrubros) ? r.subrubros : [];
    const subsFixed  = subrubros.map(sr => ({
      ...sr,
      articulos: Array.isArray(sr?.articulos) ? sr.articulos : []
    }));
    return { ...r, articulos, subrubros: subsFixed };
  });

  // filtro defensivo: solo rubros válidos con id/nombre o con algo de contenido
  const cleaned = flat.filter(r =>
    (Number.isFinite(Number(r?.id)) || typeof r?.nombre === 'string') &&
    (Array.isArray(r?.articulos) || Array.isArray(r?.subrubros))
  );

  return cleaned;
}

// ---------- persistencia ----------
async function saveMenuCache(client, businessId, source, flatRubros) {
  const payload = flatRubros; // ya normalizado
  const hash = stableHash(payload);

  const sql = `
    INSERT INTO public.maxi_menu_cache (business_id, source, payload, hash, updated_at)
    VALUES ($1, $2, $3::jsonb, $4, now())
    ON CONFLICT (business_id, hash)
    DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
    RETURNING id, updated_at
  `;
  const { rows } = await client.query(sql, [businessId, source, JSON.stringify(payload), hash]);
  return { id: rows[0]?.id, hash, updated_at: rows[0]?.updated_at };
}

// ---------- ejemplo de uso (fetch + save) ----------
async function run() {
  const bizId = Number(process.argv[2]);
  if (!Number.isFinite(bizId)) {
    console.error('Uso: node scripts/fetch_menu_cache.js <BUSINESS_ID>');
    process.exit(1);
  }

  const bearer = process.env.MAXI_BEARER; // o generá con tu login
  if (!bearer) {
    console.error('Falta MAXI_BEARER en .env (o implementá el login)');
    process.exit(1);
  }

  const MAXI_BASE = process.env.MAXI_STATS_URL || 'https://api-mconn.maxisistemas.com.ar';
  const url = `${MAXI_BASE.replace(/\/+$/,'')}/menuweb/menuextendido`;

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    const txt = await res.text();
    let json; try { json = JSON.parse(txt); } catch { json = null; }
    if (!res.ok || !json) {
      throw new Error(`Maxi menú ${res.status}: ${txt.slice(0,200)}`);
    }

    // acepta content o array directo
    const rawPayload = json?.content ?? json;
    const flat = normalizeMenuPayload(rawPayload);

    const saved = await saveMenuCache(client, bizId, 'menuweb/menuextendido', flat);
    console.log(`Guardado cache OK: business=${bizId} rows=${flat.length} hash=${saved.hash.slice(0,8)} updated_at=${saved.updated_at}`);

    // pequeño resumen
    let subr = 0, arts = 0;
    for (const r of flat) {
      const artsRub = Array.isArray(r.articulos) ? r.articulos.length : 0;
      const subs    = Array.isArray(r.subrubros) ? r.subrubros.length : 0;
      let artsSubs  = 0;
      for (const sr of (r.subrubros || [])) {
        artsSubs += Array.isArray(sr.articulos) ? sr.articulos.length : 0;
      }
      subr += subs; arts += (artsRub + artsSubs);
    }
    console.log(`Rubros: ${flat.length} | Subrubros: ${subr} | Artículos: ${arts}`);
  } catch (e) {
    console.error('Error:', e.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) run();
