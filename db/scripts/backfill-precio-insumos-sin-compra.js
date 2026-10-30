// db/scripts/backfill-precio-insumos-sin-compra.js
//
// Backfill único: para insumos que NUNCA tuvieron una compra cargada (por eso
// fix-precio-ref-bonificaciones.js nunca los toca — ese script solo mira
// insumos con purchase_items), usa el fallback nuevo de
// precioCosteoInsumos.js (aplicarFallbackM0) para asignarles precio_ref
// desde el maestro de MaxiRest (m0_listado_de_insumos_con_discontinuados),
// en vez de dejarlos con lo que tengan guardado (a veces un cálculo viejo de
// antes del fix de factor de embalaje — ej. "Lata Tónica" en 147: $18.816,28
// guardado, resabio de tratar el precio de una CAJA de 24 como si fuera 1
// unidad; el precio real por unidad del maestro es $784,012).
//
// Solo alcanza a negocios mapeados en PDV_MAP (maxiPdvMap.js) — sin eso no
// hay forma de consultar el maestro m0 de ese negocio.
//
// Uso:
//   node db/scripts/backfill-precio-insumos-sin-compra.js                 → dry-run
//   node db/scripts/backfill-precio-insumos-sin-compra.js --aplicar       → aplica
//   node db/scripts/backfill-precio-insumos-sin-compra.js --business=147 --aplicar
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { PDV_MAP } = require('../../services/maxiPdvMap');
const { propagarCostoInsumo } = require('../../services/costoRecetaService');
const { getModoCosteo, calcularPreciosPorModo, aplicarPreciosCosteo } = require('../../services/precioCosteoInsumos');

const APLICAR = process.argv.includes('--aplicar');
const bizArg = process.argv.find((a) => a.startsWith('--business='));
const SOLO_BIZ = bizArg ? Number(bizArg.split('=')[1]) : null;

async function main() {
  console.log(APLICAR ? '── Aplicando cambios en la base ──' : '── DRY RUN: se calcula todo pero NO se guarda nada ──');

  const negociosIds = [...new Set(Object.values(PDV_MAP).map((v) => v.businessId))]
    .filter((id) => !SOLO_BIZ || id === SOLO_BIZ);

  let totalTocados = 0, totalRevisados = 0;

  for (const bizId of negociosIds) {
    const { rows: insumosSinCompra } = await pool.query(
      `SELECT i.id, i.nombre, i.codigo_maxi, i.precio_ref AS precio_ref_actual
         FROM insumos i
        WHERE i.business_id = $1 AND i.codigo_maxi IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM purchase_items pi WHERE pi.insumo_id = i.id)`,
      [bizId]
    );
    if (!insumosSinCompra.length) continue;
    totalRevisados += insumosSinCompra.length;

    const client = await pool.connect();
    try {
      const modo = await getModoCosteo(bizId, client);
      const ids = insumosSinCompra.map((i) => i.id);
      const precios = await calcularPreciosPorModo(client, bizId, ids, modo);
      if (!precios || !precios.size) continue;

      const porId = new Map(insumosSinCompra.map((i) => [i.id, i]));
      const cambiados = [];
      for (const [id, precioNuevo] of precios.entries()) {
        const ins = porId.get(id);
        if (!ins) continue;
        const actual = Number(ins.precio_ref_actual) || 0;
        if (Math.abs(actual - precioNuevo) < 0.01) continue;
        cambiados.push({ id, nombre: ins.nombre, codigo: ins.codigo_maxi, actual, precioNuevo });
      }
      if (!cambiados.length) continue;

      console.log(`\nNegocio ${bizId} — ${cambiados.length} insumo(s) sin compra, con precio de m0:`);
      for (const c of cambiados) {
        console.log(`  ${c.id} "${c.nombre}" (codigo ${c.codigo}): $${c.actual.toFixed(2)} → $${c.precioNuevo.toFixed(2)}`);
      }

      if (APLICAR) {
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
    } finally {
      client.release();
    }
  }

  console.log('\n──────────────────────────────');
  console.log(`Insumos sin compra revisados: ${totalRevisados}  ·  corregidos con m0: ${totalTocados}`);
  if (!APLICAR) console.log('\n(DRY RUN: nada de esto se guardó. Corré con --aplicar para aplicarlo.)');

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
