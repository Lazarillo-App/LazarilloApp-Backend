// db/scripts/repair-costo-envase.js
//
// Repara datos ya escritos por el bug de propagarCostoInsumo que ignoraba el
// envase de insumos "u" (ver commit "fix(costeo): propagarCostoInsumo ignoraba
// el envase de insumos 'u'"). El código ya está arreglado hacia adelante —
// este script solo fuerza un recálculo de propagación para los insumos con
// envase configurado, para que las recetas que ya quedaron con un costo
// inflado (precio de la unidad/envase entero en vez de la fracción usada) se
// corrijan retroactivamente.
//
// Por cada insumo con contenido_envase configurado, llama a propagarCostoInsumo
// (misma función que ya usa el resto del sistema) — que recalcula sus
// receta_items, las recetas afectadas, y en cascada cualquier elaborado que
// las use a su vez. Solo lectura hasta el UPDATE final de cada propagación
// (son las mismas queries que ya corren en producción a diario).
//
// Uso:
//   node db/scripts/repair-costo-envase.js --business=147           (un negocio)
//   node db/scripts/repair-costo-envase.js --business=147 --dry-run (solo listar, sin tocar nada)
//
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { propagarCostoInsumo } = require('../../services/costoRecetaService');

const bizArg = process.argv.find(a => a.startsWith('--business='));
const bizId = bizArg ? Number(bizArg.split('=')[1]) : null;
const dryRun = process.argv.includes('--dry-run');

async function main() {
  if (!bizId) {
    console.error('Uso: node db/scripts/repair-costo-envase.js --business=ID [--dry-run]');
    process.exit(1);
  }

  const { rows: insumos } = await pool.query(
    `SELECT id, nombre, precio_ref, contenido_envase, unidad_envase
       FROM insumos
      WHERE business_id = $1
        AND contenido_envase > 0
        AND unidad_envase IS NOT NULL
      ORDER BY nombre`,
    [bizId]
  );

  console.log(`Insumos con envase en business_id=${bizId}: ${insumos.length}`);
  if (!insumos.length) { await pool.end(); return; }

  for (const ins of insumos) {
    console.log(`\n— ${ins.nombre} (#${ins.id}) — precio_ref=${ins.precio_ref} / ${ins.contenido_envase}${ins.unidad_envase}`);

    // Snapshot ANTES: qué recetas usan este insumo y con qué costo_unitario hoy.
    const { rows: antes } = await pool.query(
      `SELECT ri.id, ri.receta_id, ri.cantidad, ri.unidad, ri.costo_unitario
         FROM receta_items ri
         JOIN recetas r ON r.id = ri.receta_id
        WHERE ri.insumo_id = $1 AND r.business_id = $2`,
      [ins.id, bizId]
    );
    if (!antes.length) { console.log('  (no se usa en ninguna receta de este negocio)'); continue; }

    if (dryRun) {
      for (const it of antes) {
        console.log(`  [dry-run] receta_item #${it.id}: ${it.cantidad}${it.unidad} — costo_unitario actual=${it.costo_unitario}`);
      }
      continue;
    }

    await propagarCostoInsumo(ins.id, bizId, pool);

    // Snapshot DESPUÉS, para mostrar el antes/después.
    const idsAfectados = antes.map(a => a.id);
    const { rows: despues } = await pool.query(
      `SELECT id, costo_unitario FROM receta_items WHERE id = ANY($1::bigint[])`,
      [idsAfectados]
    );
    const mapaDespues = new Map(despues.map(d => [d.id, Number(d.costo_unitario)]));

    for (const it of antes) {
      const antesVal = Number(it.costo_unitario);
      const despuesVal = mapaDespues.get(it.id);
      const cambio = Math.abs(antesVal - despuesVal) > 0.01;
      console.log(`  receta_item #${it.id} (${it.cantidad}${it.unidad}): ${antesVal} → ${despuesVal}${cambio ? '  ⚠️ CAMBIÓ' : ''}`);
    }
  }

  console.log(dryRun ? '\n(dry-run: no se modificó nada)' : '\nListo.');
  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
