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
// migraciones versionadas no alcanzan): no hay UNIQUE que incluya source,
// así que no se puede usar ON CONFLICT — se borra y se reinserta.
//
// Sucursales: un negocio puede tener varios pdv (204 = FCRAMOS principal +
// FCSANJUSTO sucursal, ver maxiPdvMap.js). sales_daily_items guarda cada
// uno con su branch_id y el borrado es por sucursal; maxi_sales_daily y
// sales_daily son por negocio, así que ahí se suman las sucursales.
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
'use strict';

const pool = require('../config/db');
const { pdvsDeNegocio, verificarSucursales } = require('./maxiPdvMap');
const { rebuildSalesDailyRange } = require('./salesDailyRebuildService');

const SOURCE = 'maxi';

async function resolverTablasDelAnio(schema, prefijo) {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name LIKE $2
      ORDER BY table_name DESC`,
    [schema, `${prefijo}_%`]
  );
  return rows
    .map((r) => r.table_name)
    .filter((t) => new RegExp(`^${prefijo}_\d{4}$`).test(t));
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

// Lee i12 de cada pdv del negocio y calcula el alcance (incluido cuánto 'csv'
// de esa misma sucursal se va a pisar), sin escribir nada.
async function prepararPdv(businessId, { pdv, schema, branchId }) {
  const filas = await obtenerFilasI12(pdv, schema);
  const { grupos, sinArticulo } = agruparPorDiaYArticulo(filas);
  const diasUnicos = [...new Set(grupos.map((g) => g.dia))].sort();

  let csvAfectadas = 0;
  let csvMontoAfectado = 0;
  if (diasUnicos.length) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS filas, COALESCE(SUM(amount), 0)::numeric AS total
         FROM sales_daily_items
        WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $3::bigint
          AND source = 'csv' AND day = ANY($2::date[])`,
      [businessId, diasUnicos, branchId]
    );
    csvAfectadas = rows[0].filas;
    csvMontoAfectado = Number(rows[0].total);
  }

  return {
    pdv,
    branchId,
    grupos,
    diasUnicos,
    resumen: {
      pdv,
      branchId,
      dias: diasUnicos.length,
      rango: diasUnicos.length ? { desde: diasUnicos[0], hasta: diasUnicos[diasUnicos.length - 1] } : null,
      lineas: grupos.length,
      sinArticulo,
      csvAfectadas,
      csvMontoAfectado,
    },
  };
}

async function syncVentasDeNegocio(businessId, { dryRun = false } = {}) {
  const pdvs = pdvsDeNegocio(businessId);
  if (!pdvs.length) {
    return { ok: false, error: `Negocio ${businessId} no está en PDV_MAP todavía` };
  }
  await verificarSucursales(pool, businessId);

  const preparados = [];
  for (const destino of pdvs) preparados.push(await prepararPdv(businessId, destino));
  const porPdv = preparados.map((p) => p.resumen);

  const todosLosDias = [...new Set(preparados.flatMap((p) => p.diasUnicos))].sort();
  if (dryRun || !todosLosDias.length) {
    return { ok: true, porPdv, dryRun };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const p of preparados) {
      if (!p.grupos.length) continue;

      // Maxi pisa a csv: se borran ambas fuentes para los días que este pdv
      // cubre — sólo en SU sucursal, para no borrar lo de las demás — y se
      // reinserta sólo 'maxi' (decisión explícita del negocio: el pipeline
      // automático pasa a ser la fuente de verdad).
      await client.query(
        `DELETE FROM sales_daily_items
          WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $3::bigint
            AND source IN ('csv','maxi') AND day = ANY($2::date[])`,
        [businessId, p.diasUnicos, p.branchId]
      );

      await client.query(
        `WITH datos AS (
           SELECT * FROM UNNEST(
             $1::date[], $2::int[], $3::text[], $4::numeric[], $5::numeric[]
           ) AS t(day, article_id, article_name, qty, amount)
         )
         INSERT INTO sales_daily_items (business_id, branch_id, day, article_id, article_name, qty, amount, source)
         SELECT $6::bigint, $7::bigint, day, article_id, article_name, qty, amount, '${SOURCE}' FROM datos`,
        [
          p.grupos.map((g) => g.dia),
          p.grupos.map((g) => g.articleId),
          p.grupos.map((g) => g.nombre),
          p.grupos.map((g) => g.qty),
          p.grupos.map((g) => g.amount),
          businessId,
          p.branchId,
        ]
      );
    }

    // Espejo 1:1 por negocio (mismo criterio que el pipeline viejo,
    // salesStore.js) — no tiene branch_id, así que se suman las sucursales.
    const total = new Map();
    for (const g of preparados.flatMap((p) => p.grupos)) {
      const key = `${g.dia}__${g.articleId}`;
      const t = total.get(key) ?? { dia: g.dia, articleId: g.articleId, qty: 0, amount: 0 };
      t.qty += g.qty;
      t.amount += g.amount;
      total.set(key, t);
    }
    const sumados = [...total.values()];
    await client.query(
      `WITH datos AS (
         SELECT * FROM UNNEST(
           $1::int[], $2::date[], $3::numeric[], $4::numeric[]
         ) AS t(articulo_id, day, qty, amount)
       )
       INSERT INTO maxi_sales_daily (business_id, articulo_id, day, qty, amount)
       SELECT $5::int, articulo_id, day, qty, amount FROM datos
       ON CONFLICT (business_id, articulo_id, day) DO UPDATE SET
         qty = EXCLUDED.qty, amount = EXCLUDED.amount, updated_at = NOW()`,
      [
        sumados.map((s) => s.articleId),
        sumados.map((s) => s.dia),
        sumados.map((s) => s.qty),
        sumados.map((s) => s.amount),
        businessId,
      ]
    );

    // sales_daily: se reconstruye con la función ya existente (prefiere
    // csv sobre maxi por día+artículo+sucursal — acá da igual porque el csv
    // de estos días ya se borró arriba, así que sólo va a quedar maxi).
    await rebuildSalesDailyRange({
      businessId,
      from: todosLosDias[0],
      to: todosLosDias[todosLosDias.length - 1],
      client,
    });

    await client.query('COMMIT');
    return { ok: true, porPdv, dryRun };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { syncVentasDeNegocio };
