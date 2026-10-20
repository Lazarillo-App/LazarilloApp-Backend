// db/scripts/fix-precio-ref-bonificaciones.js
//
// Backfill único: recalcula insumos.precio_ref para TODOS los insumos con
// compras, usando el cálculo ya corregido en precioCosteoInsumos.js (costo
// real del último comprobante — o el promedio ponderado de 30 días, según el
// modo configurado del negocio — SIEMPRE incluyendo las líneas bonificadas en
// $0 en las unidades recibidas).
//
// Antes de este fix, el cálculo automático descartaba esas líneas
// (`WHERE precio > 0`), así que cualquier insumo con una promo recurrente
// (2+1, 2+2, etc.) quedaba con precio_ref inflado al precio de lista completo
// después de cada sync — salvo que alguien hubiera confirmado la bonificación
// a mano en ese insumo puntual (bonif_aceptada = true, que ya se calculaba
// bien). Este script corrige el resto del catálogo de una sola vez; de acá en
// más, cada sync nuevo ya entra bien calculado.
//
// Uso:
//   node db/scripts/fix-precio-ref-bonificaciones.js             → aplica los cambios
//   node db/scripts/fix-precio-ref-bonificaciones.js --dry-run   → solo reporta
//   node db/scripts/fix-precio-ref-bonificaciones.js --business=147  → limita a un negocio
//
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { propagarCostoInsumo } = require('../../services/costoRecetaService');
const { getModoCosteo, calcularPreciosPorModo, aplicarPreciosCosteo } = require('../../services/precioCosteoInsumos');

const DRY_RUN = process.argv.includes('--dry-run');
const bizArg = process.argv.find((a) => a.startsWith('--business='));
const SOLO_BIZ = bizArg ? Number(bizArg.split('=')[1]) : null;

async function main() {
  console.log(DRY_RUN
    ? '── DRY RUN: se calcula todo pero NO se guarda nada ──'
    : '── Aplicando cambios en la base ──');
  if (SOLO_BIZ) console.log(`Limitado al negocio ${SOLO_BIZ}`);

  const { rows: negocios } = await pool.query(
    `SELECT id FROM app_businesses ${SOLO_BIZ ? 'WHERE id = $1' : ''} ORDER BY id`,
    SOLO_BIZ ? [SOLO_BIZ] : []
  );

  let totalTocados = 0, totalRevisados = 0, totalErrores = 0;

  for (const biz of negocios) {
    const bizId = biz.id;
    const { rows: insumosConCompra } = await pool.query(
      `SELECT DISTINCT i.id, i.nombre, i.precio_ref AS precio_ref_actual
         FROM insumos i
         JOIN purchase_items pi ON pi.insumo_id = i.id
        WHERE i.business_id = $1`,
      [bizId]
    );
    if (!insumosConCompra.length) continue;

    const client = await pool.connect();
    try {
      const modo = await getModoCosteo(bizId, client);
      const ids = insumosConCompra.map((i) => i.id);
      const precios = await calcularPreciosPorModo(client, bizId, ids, modo);
      if (!precios || !precios.size) continue;

      const porId = new Map(insumosConCompra.map((i) => [i.id, i]));
      const cambiados = [];
      for (const [id, precioCorrecto] of precios.entries()) {
        const ins = porId.get(id);
        if (!ins) continue;
        const actual = Number(ins.precio_ref_actual) || 0;
        if (Math.abs(actual - precioCorrecto) < 0.01) continue;
        cambiados.push({ id, nombre: ins.nombre, actual, precioCorrecto });
      }

      totalRevisados += insumosConCompra.length;
      if (!cambiados.length) continue;

      console.log(`\nNegocio ${bizId} — modo "${modo}" — ${cambiados.length} insumo(s) a corregir:`);
      for (const c of cambiados) {
        console.log(`  ${c.id} "${c.nombre}": $${c.actual.toFixed(2)} → $${c.precioCorrecto.toFixed(2)}`);
      }

      if (!DRY_RUN) {
        await client.query('BEGIN');
        const idsActualizados = await aplicarPreciosCosteo(client, bizId, precios);
        for (const id of idsActualizados) {
          await propagarCostoInsumo(id, bizId, client);
        }
        await client.query('COMMIT');
      }
      totalTocados += cambiados.length;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { }
      console.error(`  ERROR negocio ${bizId}: ${e.message}`);
      totalErrores++;
    } finally {
      client.release();
    }
  }

  console.log('\n──────────────────────────────');
  console.log(`Insumos revisados: ${totalRevisados}  ·  corregidos: ${totalTocados}  ·  negocios con error: ${totalErrores}`);
  if (DRY_RUN) console.log('\n(DRY RUN: nada de esto se guardó. Corré sin --dry-run para aplicarlo.)');

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
