// db/scripts/investigar-referencia-insumo.js
//
// Diagnóstico de SOLO LECTURA. Para un insumo puntual, muestra TODAS las
// líneas crudas (de cualquier grupo factura_key+proveedor), con su
// `referencia` — para detectar si alguna línea es en realidad un gasto
// administrativo (ej. "Servicio de Aguas") que coincidió por casualidad
// con el codigo_maxi de un insumo real, mismo patrón que TIPOS_GASTO
// ('C'/'N') pero con otro prefijo de comprobante.
//
// Uso: node db/scripts/investigar-referencia-insumo.js <insumo_id> [--business=N]
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const insumoId = Number(process.argv[2]);
  const bizArg = process.argv.find((a) => a.startsWith('--business='));
  const businessId = bizArg ? Number(bizArg.split('=')[1]) : null;
  if (!Number.isFinite(insumoId)) {
    console.log('Uso: node db/scripts/investigar-referencia-insumo.js <insumo_id> [--business=N]');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT pi.id, p.factura_key, p.fecha, p.proveedor_id, pi.cantidad, pi.precio, pi.precio_total, pi.referencia
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
      WHERE pi.insumo_id = $1 ${businessId ? 'AND pi.business_id = $2' : ''}
      ORDER BY p.fecha DESC`,
    businessId ? [insumoId, businessId] : [insumoId]
  );
  console.log(`=== Líneas crudas de insumo ${insumoId} (${rows.length}) ===`);
  console.table(rows);

  // Prefijo del tipo de comprobante (primer "token" antes del espacio, ej. "Z", "A", "Tic")
  const prefijos = new Set(rows.map(r => String(r.factura_key).split('-')[0].trim()));
  for (const prefijo of prefijos) {
    const { rows: muestra } = await pool.query(
      `SELECT pi.referencia, COUNT(*)::int AS filas
         FROM purchase_items pi
         JOIN purchases p ON p.id = pi.purchase_id
        WHERE p.factura_key LIKE $1 ${businessId ? 'AND pi.business_id = $2' : ''}
        GROUP BY pi.referencia
        ORDER BY filas DESC
        LIMIT 15`,
      businessId ? [`${prefijo}-%`, businessId] : [`${prefijo}-%`]
    );
    console.log(`\n=== Referencias más comunes para comprobantes "${prefijo}-..." (negocio ${businessId || 'todos'}) ===`);
    console.table(muestra);
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
