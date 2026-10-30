// services/maxiPipelineSalesSync.js
//
// Ingesta de Ventas desde el pipeline nuevo del colega (mismos schemas
// `container`/`comercio` que compras — ver maxiPipelinePurchasesSync.js),
// tabla i12_ventas_por_articulo_ranking_detallado_por_dia: YA viene
// agregada por día+artículo (codigo, nombre, unidades, importe, fecha) —
// a diferencia de compras, acá no hace falta reconstruir facturas desde
// líneas sueltas, ni cruzar ningún maestro de factores.
//
// Reemplaza al sync viejo (salesSyncPolicy.js / maxiSalesService.js, que
// pega directo a la API de Maxi) — ese se cortó en octubre (6 días de 30
// cargados). Este escribe en las MISMAS tablas que ya lee el frontend
// (sales_daily / sales_daily_items), con el mismo `source='maxi'` que ya
// usa el pipeline viejo, para que un ON CONFLICT actualice en vez de
// duplicar si coexisten datos de ambos orígenes en algún día.
//
// Match de artículo: i12.codigo == maxi_articles.articulo_id (confirmado
// en salesSyncController.js:listDailyItems, el mismo campo que resuelve
// el nombre a mostrar) — nunca maxi_article_map (matching por nombre/sku,
// aproximado, el que usaba el pipeline viejo).
'use strict';

const pool = require('../config/db');
const { PDV_MAP } = require('./maxiPipelinePurchasesSync');

const SOURCE = 'maxi';

function resolverPdv(businessId) {
  const entry = Object.entries(PDV_MAP).find(([, v]) => v.businessId === Number(businessId));
  return entry ? { pdv: entry[0], schema: entry[1].schema } : null;
}

async function resolverTablasDelAnio(schema, prefijo) {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name LIKE $2
      ORDER BY table_name DESC`,
    [schema, `${prefijo}_%`]
  );
  return rows
    .map((r) => r.table_name)
    .filter((t) => new RegExp(`^${prefijo}_\\d{4}$`).test(t));
}

async function obtenerFilasI12(pdv, schema) {
  const tablas = await resolverTablasDelAnio(schema, 'i12_ventas_por_articulo_ranking_detallado_por_dia');
  if (!tablas.length) return [];
  let filas = [];
  for (const tabla of tablas) {
    const { rows } = await pool.query(
      `SELECT * FROM "${schema}"."${tabla}" WHERE pdv = $1 AND fecha IS NOT NULL`,
      [pdv]
    );
    filas = filas.concat(rows);
  }
  return filas;
}

async function syncVentasDeNegocio(businessId, { dryRun = false } = {}) {
  const resuelto = resolverPdv(businessId);
  if (!resuelto) {
    return { ok: false, error: `Negocio ${businessId} no está en PDV_MAP todavía` };
  }
  const { pdv, schema } = resuelto;

  const filas = await obtenerFilasI12(pdv, schema);
  if (!filas.length) {
    return { ok: true, dias: 0, lineas: 0, sinArticulo: 0, dryRun };
  }

  // Agrupar por (día, codigo) — codigo=0 ("ARTICULOS INEXISTENTES" en el
  // origen) queda como article_id=0, mismo convenio que ya usa el pipeline
  // viejo (sales_daily_items.article_id NOT NULL, COALESCE a 0).
  const porDiaArticulo = new Map();
  let sinArticulo = 0;
  for (const f of filas) {
    const dia = new Date(f.fecha).toISOString().slice(0, 10);
    const codigo = Number(f.codigo) || 0;
    if (codigo === 0) sinArticulo++;
    const key = `${dia}__${codigo}`;
    if (!porDiaArticulo.has(key)) {
      porDiaArticulo.set(key, { dia, articleId: codigo, qty: 0, amount: 0 });
    }
    const g = porDiaArticulo.get(key);
    g.qty += Number(f.unidades ?? 0);
    g.amount += Number(f.importe ?? 0);
  }
  const grupos = [...porDiaArticulo.values()];

  if (dryRun) {
    const dias = new Set(grupos.map((g) => g.dia)).size;
    return { ok: true, dias, lineas: grupos.length, sinArticulo, dryRun };
  }

  const dias = grupos.map((g) => g.dia);
  const articleIds = grupos.map((g) => g.articleId);
  const qtys = grupos.map((g) => g.qty);
  const amounts = grupos.map((g) => g.amount);
  const businessIds = grupos.map(() => businessId);
  const sources = grupos.map(() => SOURCE);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `WITH datos AS (
         SELECT * FROM UNNEST(
           $1::int[], $2::date[], $3::int[], $4::numeric[], $5::numeric[], $6::text[]
         ) AS t(business_id, day, article_id, qty, amount, source)
       )
       INSERT INTO sales_daily_items (business_id, day, article_id, qty, amount, source)
       SELECT business_id, day, article_id, qty, amount, source FROM datos
       ON CONFLICT (business_id, day, article_id, source) DO UPDATE SET
         qty = EXCLUDED.qty, amount = EXCLUDED.amount, updated_at = NOW()`,
      [businessIds, dias, articleIds, qtys, amounts, sources]
    );

    // Espejo 1:1, mismo criterio que upsertDailyAggregates (salesStore.js).
    await client.query(
      `WITH datos AS (
         SELECT * FROM UNNEST(
           $1::int[], $2::int[], $3::date[], $4::numeric[], $5::numeric[]
         ) AS t(business_id, articulo_id, day, qty, amount)
       )
       INSERT INTO maxi_sales_daily (business_id, articulo_id, day, qty, amount)
       SELECT business_id, articulo_id, day, qty, amount FROM datos
       ON CONFLICT (business_id, articulo_id, day) DO UPDATE SET
         qty = EXCLUDED.qty, amount = EXCLUDED.amount, updated_at = NOW()`,
      [businessIds, articleIds, dias, qtys, amounts]
    );

    // sales_daily (total + tx_count por día) — tx_count no existe en i12
    // (viene agregado por artículo, no por comprobante); se recalcula a
    // partir de lo que ya quedó en sales_daily_items para no mentir un
    // número, y tx_count se deja en el valor existente (no se toca) si ya
    // había uno de otra fuente, o 0 si es la primera vez.
    const diasUnicos = [...new Set(dias)];
    await client.query(
      `INSERT INTO sales_daily (business_id, day, total, tx_count)
       SELECT $1, d::date, COALESCE(SUM(sdi.amount), 0), COALESCE(MAX(sd.tx_count), 0)
         FROM UNNEST($2::date[]) AS d
         LEFT JOIN sales_daily_items sdi
           ON sdi.business_id = $1 AND sdi.day = d
         LEFT JOIN sales_daily sd
           ON sd.business_id = $1 AND sd.day = d
        GROUP BY d
       ON CONFLICT (business_id, day) DO UPDATE SET total = EXCLUDED.total`,
      [businessId, diasUnicos]
    );

    await client.query('COMMIT');
    return {
      ok: true,
      dias: diasUnicos.length,
      lineas: grupos.length,
      sinArticulo,
      dryRun,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { syncVentasDeNegocio };
