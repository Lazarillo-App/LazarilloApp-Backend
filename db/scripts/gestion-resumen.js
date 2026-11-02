// db/scripts/gestion-resumen.js
//
// Resumen de SOLO LECTURA de lo que cargó la ingesta de gestion, por negocio/sucursal
// y mes: cantidad y suma de compras (importe del kit, sin correcciones manuales),
// ventas y pagos, y qué porcentaje del detalle quedó enlazado a su compra.
// Sirve para comparar contra lazarillo_gestion antes del corte.
//
// Uso: node db/scripts/gestion-resumen.js [desde YYYY-MM]   (default 2025-01)
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const desde = (process.argv[2] || '2025-01') + '-01';
  const q = async (titulo, text) => {
    const { rows } = await pool.query(text, [desde]);
    console.log(`\n=== ${titulo} ===`);
    console.table(rows);
  };
  const pdv = `business_id || COALESCE('/' || branch_id, '')`;

  await q('Compras (i14) por mes: filas y suma de importe', `
    SELECT ${pdv} AS pdv, to_char(fecha, 'YYYY-MM') AS mes, count(*)::int AS filas, round(sum(importe), 2)::text AS importe
      FROM gestion_compras WHERE fecha >= $1::date GROUP BY 1, 2 ORDER BY 1, 2`);
  await q('Ventas (i22) por mes: filas con fecha y suma de importe', `
    SELECT ${pdv} AS pdv, to_char(fecha, 'YYYY-MM') AS mes, count(*)::int AS filas, round(sum(importe), 2)::text AS importe
      FROM gestion_ventas WHERE fecha >= $1::date GROUP BY 1, 2 ORDER BY 1, 2`);
  await q('Pagos (i80) por mes de pago: filas y suma', `
    SELECT ${pdv} AS pdv, to_char("fechaPago", 'YYYY-MM') AS mes, count(*)::int AS filas, round(sum(importe), 2)::text AS importe
      FROM gestion_pagos WHERE "fechaPago" >= $1::date GROUP BY 1, 2 ORDER BY 1, 2`);
  await q('Detalle (i25) enlazado a su compra', `
    SELECT ${pdv} AS pdv, count(*)::int AS lineas,
           count(*) FILTER (WHERE "compraId" IS NOT NULL)::int AS enlazadas,
           round(100.0 * count(*) FILTER (WHERE "compraId" IS NOT NULL) / NULLIF(count(*), 0), 1)::text AS pct
      FROM gestion_detalle_compras WHERE $1::date IS NOT NULL GROUP BY 1 ORDER BY 1`);
  await pool.end();
}

main().catch(async (e) => { console.error('Fatal:', e); await pool.end().catch(() => {}); process.exit(1); });
