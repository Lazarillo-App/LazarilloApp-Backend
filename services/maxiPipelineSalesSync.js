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
// cargados). Confirmado contra el esquema REAL de producción (las
// migraciones versionadas no alcanzan: sales_daily_items.pkey es sólo
// `id`, sin UNIQUE sobre business_id/day/article_id/source, así que no
// se puede usar ON CONFLICT ahí — se borra y se reinserta en su lugar).
//
// Hoy TODO lo que tiene el negocio 147 en sales_daily_items es
// source='csv' (carga manual) — el pipeline viejo de la API nunca
// escribió nada. Política acordada: para cada día que este pipeline
// cubre, 'maxi' pisa a 'csv' (se borran ambos y se reinserta sólo
// 'maxi'), porque el pipeline automático pasa a ser la fuente de
// verdad. Los días que el pipeline NO cubre (fuera del rango de i12)
// no se tocan.
//
// Match de artículo: i12.codigo == maxi_articles.articulo_id (confirmado
// en salesSyncController.js:listDailyItems, el mismo campo que resuelve
// el nombre a mostrar) — nunca maxi_article_map (matching por nombre/sku,
// aproximado, el que usaba el pipeline viejo).
'use strict';

const pool = require('../config/db');
const { PDV_MAP } = require('./maxiPdvMap');
const { rebuildSalesDailyRange } = require('./salesDailyRebuildService');

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

function agruparPorDiaYArticulo(filas) {
  const porDiaArticulo = new Map();
  let sinArticulo = 0;
  for (const f of filas) {
    const dia = new Date(f.fecha).toISOString().slice(0, 10);
    const codigo = Number(f.codigo) || 0;
    if (codigo === 0) sinArticulo++;
    const key = `${dia}__${codigo}`;
    if (!porDiaArticulo.has(key)) {
      porDiaArticulo.set(key, { dia, articleId: codigo, nombre: f.nombre || null, qty: 0, amount: 0 });
    }
    const g = porDiaArticulo.get(key);
    g.qty += Number(f.unidades ?? 0);
    g.amount += Number(f.importe ?? 0);
  }
  return { grupos: [...porDiaArticulo.values()], sinArticulo };
}

async function syncVentasDeNegocio(businessId, { dryRun = false } = {}) {
  const resuelto = resolverPdv(businessId);
  if (!resuelto) {
    return { ok: false, error: `Negocio ${businessId} no está en PDV_MAP todavía` };
  }
  const { pdv, schema } = resuelto;

  const filas = await obtenerFilasI12(pdv, schema);
  if (!filas.length) {
    return { ok: true, dias: 0, lineas: 0, sinArticulo: 0, csvAfectadas: 0, dryRun };
  }

  const { grupos, sinArticulo } = agruparPorDiaYArticulo(filas);
  const diasUnicos = [...new Set(grupos.map((g) => g.dia))].sort();
  const desde = diasUnicos[0];
  const hasta = diasUnicos[diasUnicos.length - 1];

  // Cuántas filas 'csv' van a pisarse (para avisar el alcance antes de aplicar).
  const { rows: csvRows } = await pool.query(
    `SELECT COUNT(*)::int AS filas, COALESCE(SUM(amount), 0)::numeric AS total
       FROM sales_daily_items
      WHERE business_id = $1 AND source = 'csv' AND day = ANY($2::date[])`,
    [businessId, diasUnicos]
  );
  const csvAfectadas = csvRows[0].filas;
  const csvMontoAfectado = Number(csvRows[0].total);

  if (dryRun) {
    return {
      ok: true,
      dias: diasUnicos.length,
      rango: { desde, hasta },
      lineas: grupos.length,
      sinArticulo,
      csvAfectadas,
      csvMontoAfectado,
      dryRun,
    };
  }

  const dias = grupos.map((g) => g.dia);
  const articleIds = grupos.map((g) => g.articleId);
  const nombres = grupos.map((g) => g.nombre);
  const qtys = grupos.map((g) => g.qty);
  const amounts = grupos.map((g) => g.amount);
  const businessIds = grupos.map(() => businessId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Maxi pisa a csv: se borran ambas fuentes para los días que este
    // pipeline cubre, y se reinserta sólo 'maxi' (decisión explícita del
    // negocio: el pipeline automático pasa a ser la fuente de verdad).
    await client.query(
      `DELETE FROM sales_daily_items
        WHERE business_id = $1 AND source IN ('csv','maxi') AND day = ANY($2::date[])`,
      [businessId, diasUnicos]
    );

    await client.query(
      `WITH datos AS (
         SELECT * FROM UNNEST(
           $1::int[], $2::date[], $3::int[], $4::text[], $5::numeric[], $6::numeric[]
         ) AS t(business_id, day, article_id, article_name, qty, amount)
       )
       INSERT INTO sales_daily_items (business_id, day, article_id, article_name, qty, amount, source)
       SELECT business_id, day, article_id, article_name, qty, amount, '${SOURCE}' FROM datos`,
      [businessIds, dias, articleIds, nombres, qtys, amounts]
    );

    // Espejo 1:1 (mismo criterio que el pipeline viejo, salesStore.js).
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

    // sales_daily: se reconstruye con la función ya existente (prefiere
    // csv sobre maxi por día+artículo — acá da igual porque el csv de
    // estos días ya se borró arriba, así que sólo va a quedar maxi).
    await rebuildSalesDailyRange({ businessId, from: desde, to: hasta, client });

    await client.query('COMMIT');
    return {
      ok: true,
      dias: diasUnicos.length,
      rango: { desde, hasta },
      lineas: grupos.length,
      sinArticulo,
      csvAfectadas,
      csvMontoAfectado,
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
