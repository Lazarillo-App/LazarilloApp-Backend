// db/scripts/sync-maxi-pipeline-compras.js
//
// Corre la ingesta de Compras (i25 + i80) desde el pipeline nuevo del colega
// para UN negocio. Por default es dry-run (solo cuenta facturas/items/pagos,
// no escribe nada) — agregar --aplicar para escribir de verdad.
//
// Uso: node db/scripts/sync-maxi-pipeline-compras.js 204              (dry-run)
//      node db/scripts/sync-maxi-pipeline-compras.js 204 --aplicar    (aplica)
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { syncComprasDeNegocio } = require('../services/maxiPipelinePurchasesSync');

async function main() {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const businessId = Number(args.find((a) => a !== '--aplicar'));

  if (!Number.isFinite(businessId)) {
    console.log('Uso: node db/scripts/sync-maxi-pipeline-compras.js <business_id> [--aplicar]');
    process.exit(1);
  }

  console.log(`${aplicar ? 'APLICANDO' : 'DRY-RUN (no se escribe nada)'} — negocio ${businessId}\n`);
  const resultado = await syncComprasDeNegocio(businessId, { dryRun: !aplicar });
  console.log(JSON.stringify(resultado, null, 2));

  if (!aplicar) {
    console.log('\nEsto fue un dry-run. Para aplicar de verdad, agregá --aplicar al final del comando.');
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
