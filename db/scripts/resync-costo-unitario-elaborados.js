// db/scripts/resync-costo-unitario-elaborados.js
//
// Backfill único: recalcula costo_unitario/precio_ref de TODOS los insumos elaborados
// (los que tienen receta propia activa) y propaga el resultado a las recetas que los usan.
//
// Por qué hace falta: recalcularCostoReceta calculaba mal el costo_unitario de un
// elaborado que rinde en porción/unidad y ADEMÁS tiene un peso equivalente cargado
// (rendimiento_peso/unidad_peso) — dividía el costo TOTAL del lote por el peso de
// UNA sola unidad, en vez de por la cantidad de unidades (porciones). Un elaborado de
// $52.303,83 que rinde 40 unidades de 300gr cada una quedaba con precio_ref = $174,35
// (52303,83 / 300) en vez de $1.307,60 (52303,83 / 40) — y ese número mal calculado ya
// quedó persistido en insumos.precio_ref y en el costo_unitario de cualquier receta que
// use ese elaborado, para todos los elaborados con esta combinación (rinde porción/u +
// peso equivalente cargado) creados o guardados ANTES del fix. El fix en
// costoRecetaService.js corrige el cálculo de acá en más; este script re-materializa lo
// que ya estaba guardado mal.
//
// Uso:
//   node db/scripts/resync-costo-unitario-elaborados.js             → aplica los cambios
//   node db/scripts/resync-costo-unitario-elaborados.js --dry-run   → solo reporta, no escribe
//   node db/scripts/resync-costo-unitario-elaborados.js --business=7 → limita a un negocio
//
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { recalcularCostoReceta, propagarCostoInsumo } = require('../../services/costoRecetaService');

const DRY_RUN = process.argv.includes('--dry-run');
const bizArg = process.argv.find(a => a.startsWith('--business='));
const SOLO_BIZ = bizArg ? Number(bizArg.split('=')[1]) : null;

async function main() {
  console.log(DRY_RUN
    ? '── DRY RUN: se calcula todo pero NO se guarda nada ──'
    : '── Aplicando cambios en la base ──');
  if (SOLO_BIZ) console.log(`Limitado al negocio ${SOLO_BIZ}`);

  // Elaborados = insumos con una receta PROPIA activa (r.insumo_id = i.id).
  const { rows: elaborados } = await pool.query(
    `SELECT r.id AS receta_id, i.id AS insumo_id, i.business_id, i.nombre,
            i.precio_ref AS precio_ref_antes
       FROM recetas r
       JOIN insumos i ON i.id = r.insumo_id
      WHERE r.active = TRUE
        AND r.insumo_id IS NOT NULL
        ${SOLO_BIZ ? 'AND i.business_id = $1' : ''}
      ORDER BY i.business_id, i.id`,
    SOLO_BIZ ? [SOLO_BIZ] : []
  );
  console.log(`Elaborados a procesar: ${elaborados.length}\n`);

  let ok = 0, fail = 0, conCambios = 0;
  const errores = [];

  for (const el of elaborados) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) Recalcular la receta PROPIA del elaborado con la fórmula corregida.
      const recetaCostos = await recalcularCostoReceta(el.receta_id, client);
      const costoUnitarioNuevo = Number(recetaCostos?.costo_unitario) || 0;
      const costoTotalNuevo = Number(recetaCostos?.costo_total) || 0;

      // 2) Sincronizar precio_ref/costo_receta del insumo (mismo criterio que saveRecetaElaborado).
      await client.query(
        `UPDATE insumos SET precio_ref = $1, costo_receta = $2, updated_at = NOW()
          WHERE id = $3 AND business_id = $4`,
        [
          Math.round(costoUnitarioNuevo * 1000000) / 1000000,
          Math.round(costoTotalNuevo * 1000) / 1000,
          el.insumo_id, el.business_id,
        ]
      );

      const cambio = Math.abs(costoUnitarioNuevo - Number(el.precio_ref_antes || 0)) > 0.005;
      if (cambio) {
        conCambios++;
        console.log(`  insumo ${el.insumo_id} "${el.nombre || 's/nombre'}" (biz ${el.business_id}): precio_ref ${el.precio_ref_antes} → ${costoUnitarioNuevo}`);
      }

      // 3) Propagar hacia las recetas que usan este elaborado como ingrediente.
      await propagarCostoInsumo(el.insumo_id, el.business_id, client);

      if (DRY_RUN) await client.query('ROLLBACK');
      else await client.query('COMMIT');
      ok++;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      fail++;
      errores.push({ insumoId: el.insumo_id, businessId: el.business_id, error: e.message });
      console.error(`  ERROR insumo ${el.insumo_id} (biz ${el.business_id}): ${e.message}`);
    } finally {
      client.release();
    }
  }

  console.log('\n──────────────────────────────');
  console.log(`Elaborados procesados: ${ok}/${elaborados.length}  ·  con precio_ref corregido: ${conCambios}  ·  errores: ${fail}`);
  if (errores.length) console.log('Detalle de errores:\n' + JSON.stringify(errores, null, 2));
  if (DRY_RUN) console.log('\n(DRY RUN: nada de esto se guardó. Corré sin --dry-run para aplicarlo.)');

  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
