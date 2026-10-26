// db/scripts/check-food-cost-kpis.js
//
// Diagnóstico de SOLO LECTURA — no modifica nada. Busca el negocio por
// nombre (o id) y muestra el contenido ACTUAL de food_cost_kpis en
// app_businesses.props, para confirmar si los sub-KPI (ej. Comidas/Bebidas)
// siguen en la base o si realmente se guardó un array vacío.
//
// Uso: node db/scripts/check-food-cost-kpis.js "Comercio"
//      node db/scripts/check-food-cost-kpis.js 147
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.log('Uso: node db/scripts/check-food-cost-kpis.js "<nombre o id del negocio>"');
    process.exit(1);
  }

  const esId = /^\d+$/.test(arg);
  const { rows } = await pool.query(
    esId
      ? `SELECT id, name, props FROM app_businesses WHERE id = $1`
      : `SELECT id, name, props FROM app_businesses WHERE name ILIKE $1 ORDER BY id`,
    [esId ? Number(arg) : `%${arg}%`]
  );

  if (!rows.length) {
    console.log('No se encontró ningún negocio con ese nombre/id.');
    await pool.end();
    return;
  }

  for (const r of rows) {
    const kpis = r.props?.food_cost_kpis;
    console.log(`\n=== Negocio #${r.id} — ${r.name} ===`);
    if (!Array.isArray(kpis)) {
      console.log('food_cost_kpis: NO es un array (o no existe la clave) →', kpis);
      continue;
    }
    console.log(`food_cost_kpis: ${kpis.length} KPI(s) guardados`);
    kpis.forEach((k) => {
      const vG = k.ventas?.grupos?.length ?? 0;
      const vS = k.ventas?.sueltos?.length ?? 0;
      const cG = k.compras?.grupos?.length ?? 0;
      const cS = k.compras?.sueltos?.length ?? 0;
      console.log(`  - "${k.nombre}" (general: ${!!k.general}) — ventas: ${vG} grupo(s)/${vS} suelto(s), compras: ${cG} grupo(s)/${cS} suelto(s)`);
    });
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
