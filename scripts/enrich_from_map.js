require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const bizId = Number(process.argv[2] ?? 7);

  const sql = `
    UPDATE public.maxi_articles AS ma
    SET categoria = COALESCE(m.categoria, 'Sin categoría'),
        subrubro  = COALESCE(m.subrubro,  'Sin subrubro')
    FROM public.maxi_article_map AS m
    WHERE ma.business_id = m.business_id
      AND ma.articulo_id = m.articulo_id
      AND ma.business_id = $1
  `;

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  async function ensureArticleMap(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.maxi_article_map (
        business_id  integer   NOT NULL,
        articulo_id  integer   NOT NULL,
        categoria    text      NULL,
        subrubro     text      NULL,
        updated_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, articulo_id)
      );
      CREATE INDEX IF NOT EXISTS ix_maxi_article_map_cat_sub
        ON public.maxi_article_map (business_id, categoria, subrubro);
    `);
  }

  try {
    console.log('DB =>', new URL(process.env.DATABASE_URL).host);
    await client.connect();
    await ensureArticleMap(client);

    // Chequeo: ¿hay mapeos cargados para este negocio?
    const { rows: chk } = await client.query(
      'SELECT COUNT(*)::int AS c FROM public.maxi_article_map WHERE business_id = $1',
      [bizId]
    );
    if (!chk[0] || chk[0].c === 0) {
      console.warn(`maxi_article_map vacío para business ${bizId}. Corré antes el build del mapa.`);
      return;
    }

    const res = await client.query(sql, [bizId]);
    console.log(`Filas actualizadas: ${res.rowCount}`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
