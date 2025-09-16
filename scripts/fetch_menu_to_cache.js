// scripts/fetch_menu_to_cache.js
require('dotenv').config();
const crypto = require('crypto');
const { Client } = require('pg');
const axios = require('axios');

// 🔁 Obtén token/headers para Maxi como ya lo usás en tu proyecto:
async function getTokenForBusiness(bizId) {
  const baseUrl = process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar';
  const token = process.env[`MAXI_ACCESS_TOKEN_${bizId}`];
  if (!token) {
    throw new Error(`Falta MAXI_ACCESS_TOKEN_${bizId} en .env/entorno para business ${bizId}.`);
  }
  return { access_token: token, baseUrl };
}

async function fetchMenuExtendido(baseUrl, accessToken, desde, hasta) {
  const url = `${baseUrl}/menuweb/menuextendido?fechaInicio=${desde}&fechaFin=${hasta}`;
  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 60000
  });
  // Normalizamos: algunos devuelven {content:[...]} y otros directamente [...]
  const payload = Array.isArray(data) ? data : (data?.content ?? []);
  return payload;
}

function sha256(obj) {
  const s = JSON.stringify(obj);
  return crypto.createHash('sha256').update(s).digest('hex');
}

(async () => {
  const bizId = Number(process.argv[2]);
  const desde = process.argv[3] || '2025-01-01';
  const hasta = process.argv[4] || '2030-01-01';
  if (!Number.isFinite(bizId) || bizId <= 0) {
    console.error('Uso: node scripts/fetch_menu_to_cache.js <BUSINESS_ID> [YYYY-MM-DD desde] [YYYY-MM-DD hasta]');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    await client.query(`
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

    const { access_token, baseUrl } = await getTokenForBusiness(bizId);
    const payload = await fetchMenuExtendido(baseUrl, access_token, desde, hasta);
    const hash = sha256(payload);

    await client.query(`
      INSERT INTO public.maxi_menu_cache (business_id, source, payload, hash)
      VALUES ($1, 'menuweb/menuextendido', $2::jsonb, $3)
      ON CONFLICT (business_id, hash) DO UPDATE
        SET updated_at = now()
    `, [bizId, JSON.stringify(payload), hash]);

    console.log(`Menú cacheado: business=${bizId} · items=${payload.length} · hash=${hash.slice(0,10)}…`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
