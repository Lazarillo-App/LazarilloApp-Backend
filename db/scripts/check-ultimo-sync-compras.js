// db/scripts/check-ultimo-sync-compras.js
// Diagnóstico de SOLO LECTURA: cuándo fue el último sync de compras aplicado
// (no dry-run) para un negocio, para confirmar si una corrida real llegó a
// ejecutarse o no.
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const businessId = Number(process.argv[2]);
  if (!Number.isFinite(businessId)) {
    console.log('Uso: node db/scripts/check-ultimo-sync-compras.js <business_id>');
    process.exit(1);
  }
  const { rows } = await pool.query(
    `SELECT batch_id, MAX(synced_at) AS synced_at, COUNT(*)::int AS facturas
       FROM purchases WHERE business_id = $1
      GROUP BY batch_id ORDER BY synced_at DESC LIMIT 5`,
    [businessId]
  );
  console.log(`Últimos lotes sincronizados — negocio ${businessId}:\n`);
  console.table(rows);
  await pool.end();
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
