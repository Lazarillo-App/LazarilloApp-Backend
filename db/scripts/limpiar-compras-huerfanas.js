// db/scripts/limpiar-compras-huerfanas.js
//
// Backfill único (dry-run por defecto). Una compra en `purchases` es
// "huérfana" si su factura_key ya no corresponde a NINGUNA fila del i25
// actual (ambos años) para el pdv de ese negocio — residuo del pipeline
// viejo (maxi_purchases_staging, congelado) u otra factura que MaxiRest ya
// no reporta. Estas filas se siguen sumando en food-cost (y cualquier otra
// consulta que no dedupe por día) y duplican el gasto mostrado.
//
// Uso:
//   node db/scripts/limpiar-compras-huerfanas.js <business_id>              → dry-run
//   node db/scripts/limpiar-compras-huerfanas.js <business_id> --aplicar    → borra de verdad
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { PDV_MAP } = require('../../services/maxiPipelinePurchasesSync');

function resolverPdv(businessId) {
  const entry = Object.entries(PDV_MAP).find(([, v]) => v.businessId === Number(businessId));
  return entry ? { pdv: entry[0], schema: entry[1].schema } : null;
}

async function main() {
  const businessId = Number(process.argv[2]);
  const aplicar = process.argv.includes('--aplicar');
  if (!Number.isFinite(businessId)) {
    console.log('Uso: node db/scripts/limpiar-compras-huerfanas.js <business_id> [--aplicar]');
    process.exit(1);
  }
  const resuelto = resolverPdv(businessId);
  if (!resuelto) { console.log('Negocio no está en PDV_MAP'); process.exit(1); }
  const { pdv, schema } = resuelto;

  console.log(aplicar ? '── APLICANDO — se borra de verdad ──' : '── DRY RUN: solo se reporta, no se borra nada ──');

  // factura_keys VÁLIDAS = las que existen hoy en el i25 real (ambos años).
  const { rows: tablas } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name LIKE 'i25_compras_detalle_de_compras_%'
      ORDER BY table_name DESC`,
    [schema]
  );
  const validas = new Set();
  for (const t of tablas) {
    const { rows } = await pool.query(
      `SELECT DISTINCT cod_cpb, numero1, numero2 FROM "${schema}"."${t.table_name}" WHERE pdv = $1`,
      [pdv]
    );
    for (const r of rows) {
      validas.add(`${String(r.cod_cpb ?? '').trim()}-${r.numero1}-${r.numero2}`);
    }
  }
  console.log(`factura_key válidas en i25 actual (${schema}, pdv=${pdv}): ${validas.size}`);

  // Todas las compras guardadas de este negocio.
  const { rows: guardadas } = await pool.query(
    `SELECT id, factura_key, fecha, total FROM purchases WHERE business_id = $1`,
    [businessId]
  );
  const huerfanas = guardadas.filter((p) => !validas.has(p.factura_key));

  console.log(`\nCompras guardadas: ${guardadas.length}  ·  huérfanas (ya no están en i25 actual): ${huerfanas.length}`);
  const totalHuerfano = huerfanas.reduce((s, p) => s + Number(p.total || 0), 0);
  console.log(`Monto total en facturas huérfanas: $${totalHuerfano.toFixed(2)}`);

  if (huerfanas.length) {
    console.log('\nPrimeras 15 huérfanas:');
    console.table(huerfanas.slice(0, 15));
  }

  if (!aplicar || !huerfanas.length) {
    if (!aplicar) console.log('\n(DRY RUN: nada se borró. Corré con --aplicar para borrar de verdad.)');
    await pool.end();
    return;
  }

  const ids = huerfanas.map((p) => p.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const delItems = await client.query(
      `DELETE FROM purchase_items WHERE purchase_id = ANY($1::bigint[])`, [ids]
    );
    const delPurchases = await client.query(
      `DELETE FROM purchases WHERE id = ANY($1::bigint[])`, [ids]
    );
    await client.query('COMMIT');
    console.log(`\nBorradas ${delPurchases.rowCount} factura(s) y ${delItems.rowCount} línea(s) de purchase_items.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
