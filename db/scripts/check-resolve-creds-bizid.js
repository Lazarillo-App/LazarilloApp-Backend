// db/scripts/check-resolve-creds-bizid.js
//
// Diagnóstico de SOLO LECTURA. Muestra created_from/organization_id de un
// negocio y a qué business_id resolveCredsBizId() lo redirige — para
// confirmar si insumoMap (y por lo tanto insumo_id) se está armando con un
// business_id DISTINTO al que despues usa aplicarPreciosCosteo para el
// UPDATE (que siempre filtra por el business_id crudo, sin resolver) -
// explicaria preciosActualizados:0 aunque el modo de costeo este en
// 'ultima_compra'.
//
// Uso: node db/scripts/check-resolve-creds-bizid.js <business_id>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { resolveCredsBizId } = require('../../controllers/purchasesController');

async function main() {
  const businessId = Number(process.argv[2]);
  if (!Number.isFinite(businessId)) {
    console.log('Uso: node db/scripts/check-resolve-creds-bizid.js <business_id>');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT id, name, created_from, organization_id FROM app_businesses WHERE id = $1`,
    [businessId]
  );
  console.log('=== Negocio ===');
  console.log(rows[0]);

  const credsBizId = await resolveCredsBizId(businessId);
  console.log(`\nresolveCredsBizId(${businessId}) => ${credsBizId}`);
  console.log(credsBizId === businessId
    ? '(sin redirección — insumoMap se arma con el mismo id)'
    : '(¡REDIRIGE! insumoMap se arma con otro business_id distinto del que usa el UPDATE de precio_ref)');

  // Cuántos insumos tiene CADA uno de los dos ids, para terminar de confirmar
  const conteo = await pool.query(
    `SELECT business_id, COUNT(*)::int AS n FROM insumos WHERE business_id = ANY($1::int[]) GROUP BY business_id`,
    [[businessId, credsBizId]]
  );
  console.log('\nCantidad de insumos por business_id:');
  console.table(conteo.rows);

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
