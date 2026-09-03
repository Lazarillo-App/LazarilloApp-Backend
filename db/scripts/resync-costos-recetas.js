// db/scripts/resync-costos-recetas.js
//
// Backfill único: recalcula y persiste costo_unitario/costo_total de TODAS las recetas
// de TODOS los negocios, a partir del precio_ref ACTUAL de cada insumo.
//
// Por qué hace falta: hasta el commit "Propagar costo de insumo a recetas al actualizar
// precio_ref por compras", registrar una compra actualizaba precio_ref del insumo pero
// nunca disparaba propagarCostoInsumo() — costo_total de las recetas que lo usaban quedaba
// congelado en el último valor calculado hasta que alguien reabría y volvía a guardar esa
// receta a mano. Este script aplica, una sola vez, el mismo recálculo que de ahora en más
// pasa automáticamente en cada compra nueva.
//
// Uso:
//   node db/scripts/resync-costos-recetas.js            → aplica los cambios
//   node db/scripts/resync-costos-recetas.js --dry-run   → solo reporta qué cambiaría, no escribe nada
//   node db/scripts/resync-costos-recetas.js --business=7 → limita a un negocio puntual
//
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { propagarCostoInsumo } = require('../../services/costoRecetaService');

const DRY_RUN = process.argv.includes('--dry-run');
const bizArg = process.argv.find(a => a.startsWith('--business='));
const SOLO_BIZ = bizArg ? Number(bizArg.split('=')[1]) : null;

async function main() {
  console.log(DRY_RUN
    ? '── DRY RUN: se calcula todo pero NO se guarda nada ──'
    : '── Aplicando cambios en la base ──');
  if (SOLO_BIZ) console.log(`Limitado al negocio ${SOLO_BIZ}`);

  const { rows: insumos } = await pool.query(
    `SELECT id, business_id, nombre
       FROM insumos
      WHERE business_id IS NOT NULL
        ${SOLO_BIZ ? 'AND business_id = $1' : ''}
      ORDER BY business_id, id`,
    SOLO_BIZ ? [SOLO_BIZ] : []
  );
  console.log(`Insumos a procesar: ${insumos.length}\n`);

  let ok = 0, fail = 0, conCambios = 0, recetasActualizadas = 0;
  const errores = [];

  for (const ins of insumos) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Snapshot ANTES, para poder reportar qué recetas cambiaron con este insumo.
      const { rows: antes } = await client.query(
        `SELECT DISTINCT r.id, r.costo_total
           FROM receta_items ri
           JOIN recetas r ON r.id = ri.receta_id
          WHERE ri.insumo_id = $1 AND r.business_id = $2`,
        [ins.id, ins.business_id]
      );

      await propagarCostoInsumo(ins.id, ins.business_id, client);

      if (antes.length) {
        const { rows: despues } = await client.query(
          `SELECT id, costo_total FROM recetas WHERE id = ANY($1::int[])`,
          [antes.map(r => r.id)]
        );
        const despuesMap = new Map(despues.map(r => [r.id, Number(r.costo_total)]));
        const cambiadas = antes.filter(a => {
          const nuevo = despuesMap.get(a.id);
          return nuevo != null && Math.abs(nuevo - Number(a.costo_total)) > 0.005;
        });
        if (cambiadas.length) {
          conCambios++;
          recetasActualizadas += cambiadas.length;
          console.log(`  insumo ${ins.id} "${ins.nombre || 's/nombre'}" (biz ${ins.business_id}): ${cambiadas.length} receta(s) actualizada(s)`);
        }
      }

      if (DRY_RUN) await client.query('ROLLBACK');
      else await client.query('COMMIT');
      ok++;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      fail++;
      errores.push({ insumoId: ins.id, businessId: ins.business_id, error: e.message });
      console.error(`  ERROR insumo ${ins.id} (biz ${ins.business_id}): ${e.message}`);
    } finally {
      client.release();
    }
  }

  console.log('\n──────────────────────────────');
  console.log(`Insumos procesados: ${ok}/${insumos.length}  ·  con recetas afectadas: ${conCambios}  ·  recetas actualizadas: ${recetasActualizadas}  ·  errores: ${fail}`);
  if (errores.length) console.log('Detalle de errores:\n' + JSON.stringify(errores, null, 2));
  if (DRY_RUN) console.log('\n(DRY RUN: nada de esto se guardó. Corré sin --dry-run para aplicarlo.)');

  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
