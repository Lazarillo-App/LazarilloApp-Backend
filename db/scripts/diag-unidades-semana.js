// db/scripts/diag-unidades-semana.js
//
// Diagnóstico de SOLO LECTURA (18/11/2026): las unidades de Artículos («Todo» = ventas + salidas de
// stock) no coinciden con MaxiRest (Comercio, semana 9–15/11). Compara, para un negocio y un rango,
// lo que el kit subió de MaxiRest (i12 ventas, i27 movimientos de stock) contra lo que Lazarillo
// guardó (sales_daily_items, stock_salidas), para ver en qué paso se pierden unidades.
// No escribe nada: corre dentro de una transacción READ ONLY.
//
// Uso (Render Shell):  node db/scripts/diag-unidades-semana.js comercio 2026-11-09 2026-11-15
//                      (el primer argumento es parte del nombre del negocio, o su id)
//   Detalle por artículo: agregar un 4.º argumento con palabras del nombre, separadas por coma:
//   node db/scripts/diag-unidades-semana.js 210 2026-11-09 2026-11-15 palier,braseada,bondiola,pechuga,mila
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { pdvsDeNegocio, refrescarPdvMap } = require('../../services/maxiPdvMap');
const { esTransferencia } = require('../../services/maxiPipelineStockSync');

const [quien = 'comercio', desde = '2026-11-09', hasta = '2026-11-15'] = process.argv.slice(2);

async function tablas(c, schema, prefijo) {
  const { rows } = await c.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE $2`, [schema, `${prefijo}_%`]);
  return rows.map((r) => r.table_name).filter((t) => new RegExp(`^${prefijo}_\\d{4}$`).test(t)).sort();
}
const num = (col) => `CASE WHEN TRIM(${col}::text) ~ '^-?[0-9]+([.,][0-9]+)?$' THEN REPLACE(TRIM(${col}::text), ',', '.')::numeric ELSE 0 END`;
const cod = (col) => `CASE WHEN TRIM(${col}::text) ~ '^[0-9]+(\\.0+)?$' THEN TRIM(${col}::text)::numeric::bigint ELSE 0 END`;

async function main() {
  await refrescarPdvMap({ forzar: true });
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const { rows: negocios } = await c.query(
      /^\d+$/.test(quien) ? 'SELECT id, name FROM app_businesses WHERE id = $1' : 'SELECT id, name FROM app_businesses WHERE name ILIKE $1 ORDER BY id',
      [/^\d+$/.test(quien) ? Number(quien) : `%${quien}%`]);
    console.log(`Rango ${desde} a ${hasta}. Negocios:`, negocios.map((n) => `${n.id} ${n.name}`).join(' | ') || '(ninguno)');

    for (const n of negocios) {
      const pdvs = pdvsDeNegocio(n.id);
      console.log(`\n================ ${n.id} ${n.name} · PDV: ${pdvs.map((p) => `${p.pdv}(${p.schema}, sucursal ${p.branchId ?? 'principal'})`).join(', ') || 'ninguno'}`);
      const kitVentas = new Map(); const kitStock = new Map(); const nombres = new Map();
      const add = (m, k, v) => m.set(k, (m.get(k) || 0) + Number(v || 0));

      for (const { pdv, schema } of pdvs) {
        // --- i27 crudo: conceptos de las salidas (negativas) y qué se toma como pase
        for (const t of await tablas(c, schema, 'i27_mov_de_stock_detallado_por_remito')) {
          const { rows: cobertura } = await c.query(`SELECT MIN(fecha)::date AS min, MAX(fecha)::date AS max, COUNT(*)::int AS filas FROM "${schema}"."${t}" WHERE pdv = $1`, [pdv]);
          console.log(`\n[kit] ${schema}.${t} pdv ${pdv}: cubre ${cobertura[0].min?.toISOString?.().slice(0, 10)} a ${cobertura[0].max?.toISOString?.().slice(0, 10)} (${cobertura[0].filas} filas)`);
          const { rows } = await c.query(
            `SELECT COALESCE(TRIM(concepto::text), '') AS concepto, COUNT(*)::int AS filas,
                    SUM(${num('cantidad')}) FILTER (WHERE ${num('cantidad')} < 0)::float8 AS salidas,
                    SUM(${num('cantidad')}) FILTER (WHERE ${num('cantidad')} > 0)::float8 AS entradas,
                    COUNT(*) FILTER (WHERE ${cod('codigo')} = 0)::int AS sin_codigo
               FROM "${schema}"."${t}" WHERE pdv = $1 AND fecha::date BETWEEN $2::date AND $3::date
              GROUP BY 1 ORDER BY 3 NULLS LAST`, [pdv, desde, hasta]);
          console.table(rows.map((r) => ({ ...r, tomado_como_pase: esTransferencia(r.concepto) })));
          const { rows: art } = await c.query(
            `SELECT ${cod('codigo')} AS id, MAX(nombre) AS nombre, -SUM(${num('cantidad')})::float8 AS q
               FROM "${schema}"."${t}" WHERE pdv = $1 AND fecha::date BETWEEN $2::date AND $3::date AND ${num('cantidad')} < 0
              GROUP BY 1`, [pdv, desde, hasta]);
          for (const a of art) { add(kitStock, String(a.id), a.q); nombres.set(String(a.id), a.nombre); }
          // columnas reales (por si el formato cambió)
          const { rows: cols } = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`, [schema, t]);
          console.log('   columnas:', cols.map((x) => x.column_name).join(', '));
        }
        // --- i12 crudo: ventas por artículo
        for (const t of await tablas(c, schema, 'i12_ventas_por_articulo_ranking_detallado_por_dia')) {
          const { rows: cob } = await c.query(`SELECT MIN(fecha)::date AS min, MAX(fecha)::date AS max FROM "${schema}"."${t}" WHERE pdv = $1`, [pdv]);
          console.log(`[kit] ${schema}.${t} pdv ${pdv}: cubre ${cob[0].min?.toISOString?.().slice(0, 10)} a ${cob[0].max?.toISOString?.().slice(0, 10)}`);
          const { rows: art } = await c.query(
            `SELECT ${cod('codigo')} AS id, MAX(nombre) AS nombre, SUM(${num('unidades')})::float8 AS q
               FROM "${schema}"."${t}" WHERE pdv = $1 AND fecha::date BETWEEN $2::date AND $3::date GROUP BY 1`, [pdv, desde, hasta]);
          for (const a of art) { add(kitVentas, String(a.id), a.q); nombres.set(String(a.id), a.nombre); }
        }
      }

      // --- Lo guardado en Lazarillo
      const { rows: sv } = await c.query(
        `SELECT source, branch_id, COUNT(DISTINCT day)::int AS dias, SUM(qty)::float8 AS unidades
           FROM sales_daily_items WHERE business_id = $1 AND day BETWEEN $2 AND $3 GROUP BY 1, 2 ORDER BY 1, 2`, [n.id, desde, hasta]);
      console.log('\n[lazarillo] ventas guardadas (sales_daily_items) por origen y sucursal:'); console.table(sv);
      const { rows: ss } = await c.query(
        `SELECT concepto, transferencia, branch_id, source, SUM(qty)::float8 AS unidades, MAX(updated_at) AS actualizado
           FROM stock_salidas WHERE business_id = $1 AND day BETWEEN $2 AND $3 GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC`, [n.id, desde, hasta]);
      console.log('[lazarillo] salidas de stock guardadas (stock_salidas):'); console.table(ss);

      const { rows: lv } = await c.query(`SELECT article_id::text AS id, SUM(qty)::float8 AS q FROM sales_daily_items WHERE business_id = $1 AND day BETWEEN $2 AND $3 GROUP BY 1`, [n.id, desde, hasta]);
      const { rows: ls } = await c.query(`SELECT article_id::text AS id, SUM(qty) FILTER (WHERE NOT transferencia)::float8 AS q, SUM(qty) FILTER (WHERE transferencia)::float8 AS pase FROM stock_salidas WHERE business_id = $1 AND day BETWEEN $2 AND $3 GROUP BY 1`, [n.id, desde, hasta]);
      const lzV = new Map(lv.map((r) => [r.id, r.q])); const lzS = new Map(ls.map((r) => [r.id, r]));

      // --- Por artículo: dónde difiere
      const ids = new Set([...kitVentas.keys(), ...kitStock.keys(), ...lzV.keys(), ...lzS.keys()]);
      const filas = [...ids].map((id) => {
        const kv = kitVentas.get(id) || 0; const ks = kitStock.get(id) || 0;
        const v = lzV.get(id) || 0; const s = lzS.get(id)?.q || 0; const pase = lzS.get(id)?.pase || 0;
        return { id, nombre: (nombres.get(id) || '').slice(0, 30), maxi_ventas: kv, lz_ventas: v, maxi_stock: ks, lz_stock: s, lz_pase: pase, maxi_todo: kv + ks, lz_todo: v + s };
      }).filter((f) => Math.abs(f.maxi_todo - f.lz_todo) > 0.001).sort((a, b) => Math.abs(b.maxi_todo - b.lz_todo) - Math.abs(a.maxi_todo - a.lz_todo));
      console.log(`[comparación] artículos con diferencia (${filas.length}); los 40 mayores:`);
      console.table(filas.slice(0, 40));

      // --- Detalle de artículos por nombre (4.º argumento: palabras separadas por coma)
      const palabras = String(process.argv[5] || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (palabras.length) {
        const coincide = (nm) => palabras.some((p) => String(nm || '').toLowerCase().includes(p.toLowerCase()));
        const det = [...ids].filter((id) => coincide(nombres.get(id))).map((id) => ({
          codigo: id, nombre: (nombres.get(id) || '').slice(0, 40),
          ventas: kitVentas.get(id) || 0, stock: kitStock.get(id) || 0, todo: (kitVentas.get(id) || 0) + (kitStock.get(id) || 0),
          lazarillo_todo: (lzV.get(id) || 0) + (lzS.get(id)?.q || 0),
        })).sort((a, b) => a.nombre.localeCompare(b.nombre));
        console.log(`\n[detalle] artículos que contienen: ${palabras.join(', ')} (cada código por separado)`);
        console.table(det);
        for (const { pdv, schema } of pdvs) {
          for (const t of await tablas(c, schema, 'i27_mov_de_stock_detallado_por_remito')) {
            const { rows } = await c.query(
              `SELECT fecha::date AS dia, ${cod('codigo')} AS codigo, nombre, concepto, ${num('cantidad')}::float8 AS cantidad, medida
                 FROM "${schema}"."${t}" WHERE pdv = $1 AND fecha::date BETWEEN $2::date AND $3::date AND ${num('cantidad')} < 0
                ORDER BY nombre, fecha`, [pdv, desde, hasta]);
            const r = rows.filter((x) => coincide(x.nombre)).map((x) => ({ ...x, dia: x.dia?.toISOString?.().slice(0, 10) }));
            console.log(`[detalle] salidas de stock en ${t} (${r.length} renglones):`); console.table(r);
          }
          for (const t of await tablas(c, schema, 'i12_ventas_por_articulo_ranking_detallado_por_dia')) {
            const { rows } = await c.query(
              `SELECT fecha::date AS dia, ${cod('codigo')} AS codigo, nombre, ${num('unidades')}::float8 AS unidades
                 FROM "${schema}"."${t}" WHERE pdv = $1 AND fecha::date BETWEEN $2::date AND $3::date ORDER BY nombre, fecha`, [pdv, desde, hasta]);
            const r = rows.filter((x) => coincide(x.nombre)).map((x) => ({ ...x, dia: x.dia?.toISOString?.().slice(0, 10) }));
            console.log(`[detalle] ventas en ${t} (${r.length} renglones):`); console.table(r);
          }
        }
      }
    }
    await c.query('ROLLBACK');
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
