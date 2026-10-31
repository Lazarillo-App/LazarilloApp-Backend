// db/scripts/sync-maxi-pipeline-ventas.js
//
// Corre el pipeline nuevo de Ventas (i12) para un negocio. DRY-RUN por
// defecto (no escribe nada) — agregar --aplicar para escribir de verdad.
//
// Uso:
//   node db/scripts/sync-maxi-pipeline-ventas.js <business_id> [--aplicar]
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { syncVentasDeNegocio } = require('../../services/maxiPipelineSalesSync');

async function main() {
  const businessId = Number(process.argv[2]);
  const aplicar = process.argv.includes('--aplicar');
  if (!Number.isFinite(businessId)) {
    console.log('Uso: node db/scripts/sync-maxi-pipeline-ventas.js <business_id> [--aplicar]');
    process.exit(1);
  }

  const resultado = await syncVentasDeNegocio(businessId, { dryRun: !aplicar });
  console.log(JSON.stringify(resultado, null, 2));

  if (!aplicar && resultado.ok && resultado.porPdv.some((p) => p.lineas > 0)) {
    console.log('\n(DRY-RUN — nada se escribió. Agregá --aplicar para escribir de verdad.)');
    for (const p of resultado.porPdv) {
      if (p.csvAfectadas > 0) {
        console.log(`Atención [${p.pdv}, branch_id=${p.branchId ?? 'principal'}]: esto va a BORRAR ${p.csvAfectadas} filas 'csv' ` +
          `(suman $${p.csvMontoAfectado.toFixed(2)}) en los días ${p.rango.desde} a ${p.rango.hasta}, ` +
          `y reemplazarlas por los datos de 'maxi'.`);
      }
    }
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
