// db/scripts/inventario-maxi-vs-gestion.js
//
// Diagnóstico de SOLO LECTURA. Para cada informe/maestro que el kit sube a
// container/comercio, chequea que estén las columnas que el ETL de
// lazarillo_gestion leía de los Excel de Maxi — así sabemos si podemos
// reconstruir sus datos desde nuestro pipeline en vez de migrarlos.
// Muestra también filas y rango de fechas por pdv (último año disponible).
//
// Uso: node db/scripts/inventario-maxi-vs-gestion.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

// prefijo de tabla -> columnas que exige el schema zod de gestion (lib/etl/schemas)
const ESPERADO = {
  i14_gastos_compras_detallado_: ['cod_cga', 'imputac', 'per1', 'fecha', 'codigo', 'proveedor', 'detalle', 'importe'],
  i25_compras_detalle_de_compras_: ['cod_cpb', 'numero1', 'numero2', 'totalins'],
  i80_compras_detalle_de_pagos_: ['fecha_pago', 'pago', 'orden', 'cod_cpb'],
  i22_ventas_detalladas_: ['turno', 'comprobant', 'hora', 'tipo', 'mesa', 'mozo', 'cub', 'cobro', 'cod_cobro',
    'importe', 'total', 'descuento', 'clinombre', 'clirazon', 'clicuit', 'fecha', 'cod_suc', 'nombresuc', 'cupon'],
  i71_cta_por_comprobante_: [],
  i000_nomina: ['nombreusu', 'apellido', 'fecha_ing', 'fecha_baja'],
  m6_listado_de_articulos: ['precio1', 'rubro', 'subrubro'],
  m00_listado_de_proovedores: ['razon', 'cuit', 'cbu', 'aliascbu'],
  m17_conceptos_de_caja: ['tipo', 'cod_imp', 'cod_rga', 'rubro', 'calc_rent'],
};

async function main() {
  for (const schema of ['container', 'comercio']) {
    const { rows: tablas } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name DESC`,
      [schema]
    );
    const nombres = tablas.map((t) => t.table_name);
    console.log(`\n######## ${schema} (${nombres.length} tablas) ########`);

    for (const [prefijo, esperadas] of Object.entries(ESPERADO)) {
      const tabla = nombres.find((n) => n.startsWith(prefijo)); // DESC => el año más nuevo
      if (!tabla) { console.log(`\n[FALTA] ${prefijo}*`); continue; }

      const { rows: cols } = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, tabla]
      );
      const tiene = new Set(cols.map((c) => c.column_name.toLowerCase()));
      const faltan = esperadas.filter((c) => !tiene.has(c));
      console.log(`\n=== ${schema}.${tabla} ===`);
      console.log('columnas:', [...tiene].join(', '));
      console.log(faltan.length ? `FALTAN (vs gestion): ${faltan.join(', ')}` : 'OK: tiene todas las columnas que usa gestion');

      const fecha = tiene.has('fecha') ? 'MIN(fecha)::text AS desde, MAX(fecha)::text AS hasta' : 'NULL AS desde, NULL AS hasta';
      const { rows } = await pool.query(
        `SELECT pdv, COUNT(*)::int AS filas, ${fecha} FROM "${schema}"."${tabla}" GROUP BY pdv ORDER BY pdv`
      );
      console.table(rows);
    }
  }
  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
