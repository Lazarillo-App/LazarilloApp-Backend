// db/scripts/comparar-purchases-list.js
//
// Diagnóstico de SOLO LECTURA. Replica la query real de GET /purchases
// (purchasesController.exports.list) para un insumo puntual, para ver si el
// backend ya excluye las líneas "por caja" de alguna forma que el modal de
// Compras aprovecha, o si de verdad las devuelve y el modal las está
// filtrando/perdiendo en otro lado.
//
// Uso: node db/scripts/comparar-purchases-list.js <business_id> <insumo_id>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const businessId = Number(process.argv[2]);
  const insumoId = Number(process.argv[3]);
  if (!Number.isFinite(businessId) || !Number.isFinite(insumoId)) {
    console.log('Uso: node db/scripts/comparar-purchases-list.js <business_id> <insumo_id>');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT pi.id, pi.fecha, p.factura_key AS factura, p.branch_id,
            pi.cantidad, pi.precio, pi.precio_total
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
      WHERE pi.business_id = $1 AND pi.insumo_id = $2
      ORDER BY pi.fecha DESC, p.factura_key, pi.id
      LIMIT 500`,
    [businessId, insumoId]
  );

  console.log(`${rows.length} fila(s) que devolvería GET /purchases?insumo_id=${insumoId} (sin filtro de fecha, limit 500)\n`);

  // Clasificar por "forma" del factura_key (con o sin ceros a la izquierda en
  // el primer tramo) para ver si las de "caja" están ahí pero en otro lado
  // de la lista, o si realmente no están.
  const porForma = new Map();
  for (const r of rows) {
    const primerTramo = String(r.factura).split('-')[0].trim();
    const forma = /^0+\d+$/.test(primerTramo.replace(/\s+/g, '')) ? 'con_ceros' : 'sin_ceros';
    if (!porForma.has(forma)) porForma.set(forma, []);
    porForma.get(forma).push(r);
  }

  for (const [forma, filas] of porForma) {
    console.log(`\n=== Forma "${forma}" — ${filas.length} fila(s) — primeras 5 ===`);
    console.table(filas.slice(0, 5));
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
