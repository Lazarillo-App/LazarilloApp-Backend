// db/scripts/diagnostico-sucursal-san-justo.js
//
// Diagnóstico de SOLO LECTURA antes de mapear FCSANJUSTO (sucursal San Justo
// del negocio 204) en maxiPdvMap.js. Los pipelines de compras (i25/i80) y
// ventas (i12) hoy asumen un pdv por negocio y sin sucursal; esto chequea:
//   1) qué sucursales (app_branches) tiene 204 en prod
//   2) las claves únicas reales de las tablas que escriben los pipelines
//      (las migraciones del repo no reflejan todo lo que hay en prod)
//   3) cómo están repartidas hoy las filas de 204 por branch_id/source
//   4) si m0 (catálogo de insumos) es compartido o tiene pdv propio
//   5) si números de factura (i25) u órdenes de pago (i80) de FCSANJUSTO
//      chocan con los de FCRAMOS dentro del mismo negocio
//
// Uso: node db/scripts/diagnostico-sucursal-san-justo.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function tablasDe(schema, prefijo) {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name ~ $2 ORDER BY table_name`,
    [schema, `^${prefijo}_\\d{4}$`]
  );
  return rows.map((r) => r.table_name);
}

async function main() {
  console.log('\n=== 1) app_branches de 147 / 204 / 210 ===');
  const { rows: branches } = await pool.query(
    `SELECT id, business_id, name, created_at::date FROM app_branches
      WHERE business_id IN (147, 204, 210) ORDER BY business_id, id`
  );
  console.table(branches);

  console.log('\n=== 2) claves únicas / PK reales ===');
  const { rows: idx } = await pool.query(
    `SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('sales_daily_items','sales_daily','maxi_sales_daily','purchases','purchase_items','purchase_payments')
        AND indexdef ILIKE '%UNIQUE%'
      ORDER BY tablename, indexname`
  );
  for (const r of idx) console.log(`${r.tablename}: ${r.indexdef}`);

  const { rows: cols } = await pool.query(
    `SELECT table_name, string_agg(column_name, ', ' ORDER BY ordinal_position) AS columnas
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('sales_daily_items','maxi_sales_daily','purchase_payments')
      GROUP BY table_name`
  );
  console.table(cols);

  console.log('\n=== 3) filas de 204 por branch_id / source ===');
  const { rows: sdi } = await pool.query(
    `SELECT branch_id, source, COUNT(*)::int AS filas, MIN(day)::text AS desde, MAX(day)::text AS hasta
       FROM sales_daily_items WHERE business_id = 204 GROUP BY 1, 2 ORDER BY 1, 2`
  );
  console.log('sales_daily_items:'); console.table(sdi);
  const { rows: pur } = await pool.query(
    `SELECT branch_id, COUNT(*)::int AS facturas, MIN(fecha)::text AS desde, MAX(fecha)::text AS hasta
       FROM purchases WHERE business_id = 204 GROUP BY 1 ORDER BY 1`
  );
  console.log('purchases:'); console.table(pur);
  const { rows: pay } = await pool.query(
    `SELECT pdv, COUNT(*)::int AS pagos FROM purchase_payments WHERE business_id = 204 GROUP BY 1 ORDER BY 1`
  );
  console.log('purchase_payments:'); console.table(pay);

  console.log('\n=== 4) m0 en container: ¿tiene pdv? ===');
  const { rows: m0cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'container' AND table_name = 'm0_listado_de_insumos_con_discontinuados'`
  );
  const tienePdv = m0cols.some((c) => c.column_name === 'pdv');
  console.log('columnas:', m0cols.map((c) => c.column_name).join(', '));
  if (tienePdv) {
    const { rows } = await pool.query(
      `SELECT pdv, COUNT(*)::int AS insumos FROM container.m0_listado_de_insumos_con_discontinuados GROUP BY 1 ORDER BY 1`
    );
    console.table(rows);
  }

  console.log('\n=== 5) choques FCRAMOS vs FCSANJUSTO ===');
  for (const t of await tablasDe('container', 'i25_compras_detalle_de_compras')) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS facturas_en_ambos FROM (
         SELECT cod_cpb, numero1, numero2 FROM container."${t}" WHERE pdv = 'FCRAMOS'
         INTERSECT
         SELECT cod_cpb, numero1, numero2 FROM container."${t}" WHERE pdv = 'FCSANJUSTO') x`
    );
    console.log(`${t}: misma factura_key en las dos sucursales = ${rows[0].facturas_en_ambos}`);
  }
  for (const t of await tablasDe('container', 'i80_compras_detalle_de_pagos')) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS ordenes_en_ambos FROM (
         SELECT orden FROM container."${t}" WHERE pdv = 'FCRAMOS'
         INTERSECT
         SELECT orden FROM container."${t}" WHERE pdv = 'FCSANJUSTO') x`
    );
    console.log(`${t}: mismo orden de pago en las dos sucursales = ${rows[0].ordenes_en_ambos}`);
  }
  for (const t of await tablasDe('container', 'i12_ventas_por_articulo_ranking_detallado_por_dia')) {
    const { rows } = await pool.query(
      `SELECT pdv, COUNT(*)::int AS filas, MIN(fecha)::text AS desde, MAX(fecha)::text AS hasta
         FROM container."${t}" WHERE pdv IN ('FCRAMOS','FCSANJUSTO') GROUP BY 1 ORDER BY 1`
    );
    console.log(`${t}:`); console.table(rows);
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
