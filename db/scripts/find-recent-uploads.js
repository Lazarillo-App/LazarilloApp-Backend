// db/scripts/find-recent-uploads.js
//
// Diagnóstico de SOLO LECTURA — no modifica nada. Para cuando una carga
// directa a la base puede haber ido a parar a otro negocio (o a uno nuevo)
// en vez del esperado: busca en TODA la base, no en uno puntual.
//
// Uso:
//   node db/scripts/find-recent-uploads.js                → todo, últimos 10 días
//   node db/scripts/find-recent-uploads.js --org=9         → limita a una organización
//   node db/scripts/find-recent-uploads.js --since=2026-10-08
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

const orgArg = process.argv.find(a => a.startsWith('--org='));
const ORG_ID = orgArg ? Number(orgArg.split('=')[1]) : null;
const sinceArg = process.argv.find(a => a.startsWith('--since='));
const SINCE = sinceArg ? sinceArg.split('=')[1] : null;

async function main() {
  if (ORG_ID) {
    console.log(`── Negocios de la organización ${ORG_ID} ──`);
    const r = await pool.query(
      `SELECT id, name, parent_id, created_at, updated_at
         FROM app_businesses WHERE organization_id = $1 ORDER BY id`,
      [ORG_ID]
    );
    console.table(r.rows);
  }

  console.log(`\n── Negocios creados/modificados más recientemente (top 15) ──`);
  const recientes = await pool.query(
    `SELECT id, name, organization_id, created_at, updated_at
       FROM app_businesses
      ORDER BY GREATEST(created_at, COALESCE(updated_at, created_at)) DESC
      LIMIT 15`
  );
  console.table(recientes.rows);

  const since = SINCE || '2026-10-08';
  console.log(`\n── ¿En qué negocio hay compras/ventas con fecha >= ${since}? ──`);

  const compras = await pool.query(
    `SELECT b.id, b.name, COUNT(*)::int AS compras, MAX(p.fecha) AS fecha_mas_reciente
       FROM purchases p
       JOIN app_businesses b ON b.id = p.business_id
      WHERE p.fecha >= $1::date
      GROUP BY b.id, b.name
      ORDER BY fecha_mas_reciente DESC`,
    [since]
  );
  console.log('purchases:');
  console.table(compras.rows);

  const ventas = await pool.query(
    `SELECT b.id, b.name, COUNT(*)::int AS filas, MAX(s.day) AS dia_mas_reciente
       FROM sales_daily_items s
       JOIN app_businesses b ON b.id = s.business_id
      WHERE s.day >= $1::date
      GROUP BY b.id, b.name
      ORDER BY dia_mas_reciente DESC`,
    [since]
  );
  console.log('sales_daily_items:');
  console.table(ventas.rows);

  const insumosNuevos = await pool.query(
    `SELECT b.id, b.name, COUNT(*)::int AS insumos_nuevos, MAX(i.created_at) AS mas_reciente
       FROM insumos i
       JOIN app_businesses b ON b.id = i.business_id
      WHERE i.created_at >= $1::date
      GROUP BY b.id, b.name
      ORDER BY mas_reciente DESC`,
    [since]
  );
  console.log('insumos (creados, no solo actualizados):');
  console.table(insumosNuevos.rows);

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
