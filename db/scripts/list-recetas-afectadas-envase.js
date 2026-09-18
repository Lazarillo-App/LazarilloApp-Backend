// db/scripts/list-recetas-afectadas-envase.js
//
// Lista, con nombre de receta/artículo, todos los receta_items afectados por
// el bug de propagación de envase (insumo comprado por unidad/envase, usado
// en la receta por una unidad física distinta — oz/ml/gr/lt — costeado como
// si fuera el envase entero). Solo lectura.
//
// Uso:
//   node db/scripts/list-recetas-afectadas-envase.js --business=147
//
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

const bizArg = process.argv.find(a => a.startsWith('--business='));
const bizId = bizArg ? Number(bizArg.split('=')[1]) : null;

async function nombreReceta(rec, bizId) {
  if (rec.article_id != null) {
    const artId = Number(rec.article_id);
    if (artId > 0) {
      const { rows } = await pool.query(
        `SELECT nombre FROM maxi_articles WHERE business_id = $1 AND articulo_id = $2 LIMIT 1`,
        [bizId, artId]
      );
      if (rows[0]?.nombre) return `${rows[0].nombre} (artículo #${artId})`;
    } else {
      const { rows } = await pool.query(
        `SELECT nombre FROM app_articles WHERE business_id = $1 AND id = $2 LIMIT 1`,
        [bizId, Math.abs(artId)]
      );
      if (rows[0]?.nombre) return `${rows[0].nombre} (artículo #${artId})`;
    }
    return `Artículo #${artId} (nombre no encontrado)`;
  }
  if (rec.insumo_id != null) {
    const { rows } = await pool.query(`SELECT nombre FROM insumos WHERE id = $1`, [rec.insumo_id]);
    return `${rows[0]?.nombre || '?'} — ELABORADO (insumo #${rec.insumo_id})`;
  }
  return `receta #${rec.id} (sin article_id ni insumo_id)`;
}

async function main() {
  if (!bizId) {
    console.error('Uso: node db/scripts/list-recetas-afectadas-envase.js --business=ID');
    process.exit(1);
  }

  const { rows: items } = await pool.query(
    `SELECT ri.id AS item_id, ri.receta_id, ri.cantidad, ri.unidad, ri.costo_unitario,
            i.nombre AS insumo_nombre, i.contenido_envase, i.unidad_envase, i.precio_ref,
            r.article_id, r.insumo_id
       FROM receta_items ri
       JOIN insumos i ON i.id = ri.insumo_id
       JOIN recetas r ON r.id = ri.receta_id
      WHERE r.business_id = $1
        AND i.contenido_envase > 0
        AND i.unidad_envase IS NOT NULL
        AND lower(trim(ri.unidad)) NOT IN ('u', 'unidad', 'unidades', 'un')
      ORDER BY r.id`,
    [bizId]
  );

  console.log(`Ítems de receta potencialmente afectados en business_id=${bizId}: ${items.length}\n`);

  const porReceta = new Map();
  for (const it of items) {
    if (!porReceta.has(it.receta_id)) porReceta.set(it.receta_id, []);
    porReceta.get(it.receta_id).push(it);
  }

  for (const [recetaId, its] of porReceta) {
    const nombre = await nombreReceta(its[0], bizId);
    console.log(`── ${nombre} — receta #${recetaId} ──`);
    for (const it of its) {
      const sospechoso = Math.abs(Number(it.costo_unitario) - Number(it.precio_ref)) < 0.01;
      console.log(`  ${it.insumo_nombre}: ${Number(it.cantidad)}${it.unidad} — costo_unitario guardado=${Number(it.costo_unitario)}${sospechoso ? '  ⚠️ = precio_ref del envase entero (sin convertir)' : ''}`);
    }
    console.log('');
  }

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
