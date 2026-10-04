// db/scripts/heal-dead-recipe-precio-ref.js
//
// Backfill único: encuentra insumos cuyo precio_ref quedó pisado por una receta
// INACTIVA (borrada/reemplazada) que seguía teniendo receta_items — propagarCostoInsumo
// no filtraba r.active en esa consulta (ya corregido en costoRecetaService.js), así que
// cada vez que corría la cascada "revivía" esa receta muerta y le escribía a
// insumos.precio_ref el costo_unitario de un dato viejo/absurdo. Caso real: "BARRIL
// IRISH" terminó en $3.005.932,46/L (receta #1327, inactiva) en vez de ~$2.700/L (su
// última compra real).
//
// Esto NO vuelve a correr propagarCostoInsumo con la query vieja (ya está arreglada) —
// solo recalcula precio_ref de estos insumos puntuales a partir de su historial de
// COMPRAS real (mismo mecanismo que usa una compra nueva: services/precioCosteoInsumos.js),
// y después propaga ese precio correcto hacia las recetas que los usan.
//
// Uso:
//   node db/scripts/heal-dead-recipe-precio-ref.js            → aplica los cambios
//   node db/scripts/heal-dead-recipe-precio-ref.js --dry-run  → solo reporta
//
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { propagarCostoInsumo } = require('../../services/costoRecetaService');
const { getModoCosteo, calcularPreciosPorModo, aplicarPreciosCosteo } = require('../../services/precioCosteoInsumos');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(DRY_RUN
    ? '── DRY RUN: se calcula todo pero NO se guarda nada ──'
    : '── Aplicando cambios en la base ──');

  // Insumos con una receta INACTIVA propia (insumo_id) Y que además tienen compras
  // reales registradas — son los candidatos a este bug (precio_ref pisado por la
  // receta muerta en vez de reflejar su última compra).
  const { rows: candidatos } = await pool.query(
    `SELECT DISTINCT i.id, i.business_id, i.nombre, i.precio_ref AS precio_ref_actual
       FROM insumos i
       JOIN recetas r ON r.insumo_id = i.id AND r.active = FALSE
      WHERE EXISTS (
        SELECT 1 FROM purchase_items pi
         WHERE pi.insumo_id = i.id AND pi.precio > 0
      )
      ORDER BY i.business_id, i.id`
  );
  console.log(`Insumos candidatos (receta inactiva propia + compras reales): ${candidatos.length}\n`);

  let sanados = 0;
  for (const ins of candidatos) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const modo = await getModoCosteo(ins.business_id, client);
      const precios = await calcularPreciosPorModo(client, ins.business_id, [ins.id], modo);
      const precioCorrecto = precios?.get(ins.id);
      if (precioCorrecto == null) {
        console.log(`  insumo ${ins.id} "${ins.nombre}" (biz ${ins.business_id}): sin precio de compra calculable con modo "${modo}" — se deja como está`);
        await client.query('ROLLBACK');
        continue;
      }
      const actual = Number(ins.precio_ref_actual);
      if (Math.abs(actual - precioCorrecto) < 0.01) {
        console.log(`  insumo ${ins.id} "${ins.nombre}" (biz ${ins.business_id}): precio_ref ya está bien ($${actual})`);
        await client.query('ROLLBACK');
        continue;
      }
      console.log(`  insumo ${ins.id} "${ins.nombre}" (biz ${ins.business_id}): $${actual} → $${precioCorrecto}`);
      if (!DRY_RUN) {
        await aplicarPreciosCosteo(client, ins.business_id, precios);
        await propagarCostoInsumo(ins.id, ins.business_id, client);
      }
      sanados++;
      if (DRY_RUN) await client.query('ROLLBACK');
      else await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`  ERROR insumo ${ins.id} (biz ${ins.business_id}): ${e.message}`);
    } finally {
      client.release();
    }
  }

  console.log(`\nInsumos sanados: ${sanados}/${candidatos.length}`);
  if (DRY_RUN) console.log('(DRY RUN: nada de esto se guardó. Corré sin --dry-run para aplicarlo.)');
  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
