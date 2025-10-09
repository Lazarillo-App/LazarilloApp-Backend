// scripts/build_article_map_from_cache.js
require('dotenv').config();
const { Client } = require('pg');

function toStr(v) {
  return (v == null) ? null : String(v).trim();
}

function getArticuloId(a) {
  // Probar nombres más comunes que devuelve Maxi
  const candidates = [
    a?.idArticulo, a?.id, a?.articulo_id, a?.idArticuloMP, a?.idArticuloMenu, a?.codigoArticulo
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Por si viene como string numérica en otra clave
  for (const k of Object.keys(a || {})) {
    if (/id.*art/i.test(k)) {
      const n = Number(a[k]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function collectArticulosFromList(list, categoria, subrubro, out) {
  if (!Array.isArray(list)) return;
  for (const a of list) {
    const id = getArticuloId(a);
    if (id) {
      out.push({ articulo_id: id, categoria: toStr(categoria), subrubro: toStr(subrubro) });
    }
  }
}

function walkMenuForMap(menu) {
  const out = [];

  for (const rubro of menu) {
    const cat = toStr(rubro?.nombre) || toStr(rubro?.categoria) || toStr(rubro?.rubro) || null;

    // Artículos directamente bajo el rubro
    collectArticulosFromList(rubro?.articulos, cat, null, out);

    // Algunas respuestas usan 'categorias' además de 'subrubros'
    const grupos = []
      .concat(Array.isArray(rubro?.subrubros) ? rubro.subrubros : [])
      .concat(Array.isArray(rubro?.categorias) ? rubro.categorias : []);

    for (const grupo of grupos) {
      const sub = toStr(grupo?.nombre) || toStr(grupo?.subrubro) || toStr(grupo?.categoria) || null;
      collectArticulosFromList(grupo?.articulos, cat, sub, out);

      // Por si hay otro nivel anidado tipo sub-subrubros
      if (Array.isArray(grupo?.subrubros)) {
        for (const sub2 of grupo.subrubros) {
          const subName2 = toStr(sub2?.nombre) || toStr(sub2?.subrubro) || null;
          collectArticulosFromList(sub2?.articulos, cat, subName2, out);
        }
      }
    }
  }

  return out;
}

(async () => {
  const bizId = Number(process.argv[2]);
  if (!Number.isFinite(bizId) || bizId <= 0) {
    console.error('Uso: node scripts/build_article_map_from_cache.js <BUSINESS_ID>');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    // Leer último payload del caché
    const { rows } = await client.query(`
      SELECT payload
      FROM public.maxi_menu_cache
      WHERE business_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
    `, [bizId]);

    if (!rows.length) {
      console.log('No hay cache: corre primero fetch_menu_to_cache.js');
      return;
    }
    const menu = Array.isArray(rows[0].payload) ? rows[0].payload : (rows[0].payload?.content || []);

    // Aplano a mapa
    const mapped = walkMenuForMap(menu);

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

    // UPSERT por lotes
    const chunkSize = 1000;
    for (let i = 0; i < mapped.length; i += chunkSize) {
      const slice = mapped.slice(i, i + chunkSize);
      const values = [];
      const params = [];
      let p = 1;
      for (const row of slice) {
        values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(bizId, row.articulo_id, row.categoria, row.subrubro);
      }
      await client.query(`
        INSERT INTO public.maxi_article_map (business_id, articulo_id, categoria, subrubro)
        VALUES ${values.join(',')}
        ON CONFLICT (business_id, articulo_id) DO UPDATE
          SET categoria = EXCLUDED.categoria,
              subrubro  = EXCLUDED.subrubro,
              updated_at = now()
      `, params);
    }

    console.log(`Mapeados ${mapped.length} artículos con categoría/subrubro para business ${bizId}.`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
