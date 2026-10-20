// db/scripts/check-business-147.js
//
// Diagnóstico de SOLO LECTURA — no modifica nada. Muestra, para el negocio
// 147, cuántas filas hay en las tablas principales y cuándo fue la última
// vez que cada una se tocó, para verificar si una carga directa a la base
// (sin pasar por la app) realmente entró.
//
// Uso: node db/scripts/check-business-147.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

const BIZ_ID = Number(process.argv[2]) || 147;

async function main() {
  console.log(`── Negocio ${BIZ_ID} ──`);
  const biz = await pool.query(
    `SELECT id, name, organization_id, created_at, updated_at FROM app_businesses WHERE id = $1`,
    [BIZ_ID]
  );
  if (!biz.rows.length) {
    console.log(`❌ No existe ningún negocio con id=${BIZ_ID} en esta base.`);
    await pool.end();
    return;
  }
  console.log(biz.rows[0]);

  console.log(`\n── Actividad reciente por tabla (negocio ${BIZ_ID}) ──`);

  const checks = [
    { tabla: 'insumos', sql: `SELECT COUNT(*)::int AS total, MAX(updated_at) AS ultima_actividad FROM insumos WHERE business_id = $1` },
    { tabla: 'app_articles', sql: `SELECT COUNT(*)::int AS total, MAX(updated_at) AS ultima_actividad FROM app_articles WHERE business_id = $1` },
    { tabla: 'maxi_articles', sql: `SELECT COUNT(*)::int AS total, MAX(updated_at) AS ultima_actividad FROM maxi_articles WHERE business_id = $1` },
    { tabla: 'recetas', sql: `SELECT COUNT(*)::int AS total, MAX(updated_at) AS ultima_actividad FROM recetas WHERE business_id = $1` },
    { tabla: 'purchases', sql: `SELECT COUNT(*)::int AS total, MAX(updated_at) AS ultima_actividad, MAX(fecha) AS fecha_mas_reciente FROM purchases WHERE business_id = $1` },
    { tabla: 'purchase_items', sql: `SELECT COUNT(*)::int AS total, MAX(fecha) AS fecha_mas_reciente FROM purchase_items WHERE business_id = $1` },
    { tabla: 'sales_daily_items', sql: `SELECT COUNT(*)::int AS total, MAX(day) AS dia_mas_reciente FROM sales_daily_items WHERE business_id = $1` },
  ];

  for (const c of checks) {
    try {
      const r = await pool.query(c.sql, [BIZ_ID]);
      console.log(`${c.tabla}:`, r.rows[0]);
    } catch (e) {
      console.log(`${c.tabla}: ERROR — ${e.message}`);
    }
  }

  // Lo último que se guardó en CUALQUIER tabla con updated_at — para ver de
  // un vistazo si hubo actividad hoy/ayer en este negocio (una carga directa
  // a la base también actualiza updated_at si el script/INSERT lo setea).
  console.log(`\n── Últimas 10 filas tocadas (insumos + app_articles + recetas) ──`);
  const ultimas = await pool.query(
    `(SELECT 'insumos' AS tabla, id, nombre AS detalle, updated_at FROM insumos WHERE business_id = $1 ORDER BY updated_at DESC LIMIT 10)
     UNION ALL
     (SELECT 'app_articles' AS tabla, id, name AS detalle, updated_at FROM app_articles WHERE business_id = $1 ORDER BY updated_at DESC LIMIT 10)
     UNION ALL
     (SELECT 'recetas' AS tabla, id, nombre AS detalle, updated_at FROM recetas WHERE business_id = $1 ORDER BY updated_at DESC LIMIT 10)
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 10`,
    [BIZ_ID]
  );
  console.table(ultimas.rows);

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
