// db/scripts/listar-compras-sin-insumo.js
//
// Diagnóstico de SOLO LECTURA. Lista los códigos de insumo de MaxiRest (de
// i25_compras_detalle_de_compras) que no matchean ningún insumo de
// Lazarillo (insumos.codigo_maxi) — para revisar antes de aplicar la
// ingesta si son insumos que faltan crear, o un problema de datos.
//
// Uso: node db/scripts/listar-compras-sin-insumo.js <business_id>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { listarCodigosSinInsumo } = require('../../services/maxiPipelinePurchasesSync');

async function main() {
  const businessId = Number(process.argv[2]);
  if (!Number.isFinite(businessId)) {
    console.log('Uso: node db/scripts/listar-compras-sin-insumo.js <business_id>');
    process.exit(1);
  }

  const resultado = await listarCodigosSinInsumo(businessId);
  if (!resultado.ok) {
    console.error(resultado.error);
    process.exit(1);
  }

  console.log(`${resultado.codigos.length} código(s) de insumo sin match (ordenados por cuántas líneas de compra afectan):\n`);
  resultado.codigos.forEach((c) => {
    console.log(`  código ${c.codigo} — "${c.nombre}" (${c.rubro || 'sin rubro'}) — ${c.lineas} línea(s)`);
  });

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
