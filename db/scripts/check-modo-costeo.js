// db/scripts/check-modo-costeo.js
//
// Diagnóstico de SOLO LECTURA. Muestra el modo de costeo configurado
// (Configuración > Insumos > "Precio de costeo") para un negocio — si está
// en 'precio_db' (fijo/manual), precioCosteoInsumos.js nunca actualiza
// precio_ref solo con las compras que entran (por diseño), lo que explica
// preciosActualizados:0 en todas las corridas de sync-maxi-pipeline-compras.
//
// Uso: node db/scripts/check-modo-costeo.js <business_id>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const businessId = Number(process.argv[2]);
  if (!Number.isFinite(businessId)) {
    console.log('Uso: node db/scripts/check-modo-costeo.js <business_id>');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT id, name, props->>'precio_costeo_insumos' AS modo FROM app_businesses WHERE id = $1`,
    [businessId]
  );
  if (!rows.length) {
    console.log('No existe ese negocio.');
    await pool.end();
    return;
  }
  const modo = rows[0].modo || 'ultima_compra (default — no hay nada guardado todavía)';
  console.log(`Negocio #${rows[0].id} — ${rows[0].name}`);
  console.log(`Modo de costeo configurado: ${modo}`);

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
