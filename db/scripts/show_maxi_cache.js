// scripts/show_maxi_cache.js
require('dotenv').config();
const { Client } = require('pg');

async function ensureTable(client) {
  // Solo asegura la existencia con el MISMO esquema de la migración
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.maxi_menu_cache (
      business_id  integer      NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
      payload      jsonb        NOT NULL,
      hash         text         NOT NULL,
      updated_at   timestamptz  NOT NULL DEFAULT now(),
      PRIMARY KEY (business_id, hash)
    );
    CREATE INDEX IF NOT EXISTS maxi_menu_cache_biz_updated_idx
      ON public.maxi_menu_cache (business_id, updated_at DESC);
  `);
}

(async () => {
  const bizId = Number(process.argv[2]);
  if (!Number.isFinite(bizId) || bizId <= 0) {
    console.error('Uso: node scripts/show_maxi_cache.js <BUSINESS_ID>');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === '0' ? false : { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    await ensureTable(client);

    // Trae el último snapshot por updated_at
    const { rows } = await client.query(`
      SELECT updated_at AS fetched_at, payload
      FROM public.maxi_menu_cache
      WHERE business_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
    `, [bizId]);

    if (!rows.length) {
      console.log('No hay cache para ese business.');
      return;
    }

    const { fetched_at, payload } = rows[0];
    // El payload puede venir como array directo o envuelto en .content
    const content = Array.isArray(payload) ? payload : (payload?.content || []);

    console.log(`Última cache: ${new Date(fetched_at).toISOString()} — rubros: ${content.length}`);

    let subr = 0, arts = 0;
    for (const r of content) {
      const subs = Array.isArray(r?.subrubros) ? r.subrubros.length : 0;
      const artsRub = Array.isArray(r?.articulos) ? r.articulos.length : 0;
      let artsSubs = 0;
      for (const sr of (r?.subrubros || [])) {
        artsSubs += Array.isArray(sr?.articulos) ? sr.articulos.length : 0;
      }
      subr += subs;
      arts += (artsRub + artsSubs);
    }
    console.log(`Subrubros totales: ${subr} — Artículos totales: ${arts}`);

    console.log('\nPrimeros rubros:');
    content.slice(0, 10).forEach(r => console.log(` - ${r?.nombre ?? '(sin nombre)'}`));

  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
