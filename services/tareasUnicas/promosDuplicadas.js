// services/tareasUnicas/promosDuplicadas.js
//
// Tarea ÚNICA (Diego 12/11/2026): «convertir en promo» y «crear promo» creaban un artículo MANUAL
// nuevo con el mismo nombre que el de MaxiRest (el que se vende), y la receta buena quedaba en el
// duplicado. Esta tarea pasa la receta del duplicado al artículo de MaxiRest y borra los duplicados.
// Lista revisada con Diego (pares original ← duplicado). Respaldo previo: tablas lz_bkp_promodup_*.
'use strict';

const pool = require('../../config/db');
const { recalcularCostoReceta, actualizarComponentesDePromos } = require('../costoRecetaService');
const { avisarAlEquipoSinEsperar } = require('../notificationService');
const { invalidateCacheForBiz } = require('../../middleware/cacheJson');

const NOMBRE = 'promos_duplicadas_20261112';

// Container Bar (147): la receta del duplicado pasa al artículo de MaxiRest.
const MOVER = [
  { biz: 147, original: 571, duplicado: -1270 },   // Nachos salchis bastones albondigas (hoy «#1 Degustación Street Food»)
  { biz: 147, original: 6342, duplicado: -1279 },  // Heineken 6x5.
  { biz: 147, original: 1538, duplicado: -1283 },  // Merienda kidspark rellenas
  { biz: 147, original: 1540, duplicado: -1280, sumar: [-1281] }, // Merienda kidspark alfajor negro: todo junto, Diego la edita
];
// Duplicados que se borran sin pasar nada (se contienen a sí mismos o al producto de siempre).
const BORRAR = [
  { biz: 147, ids: [-1281, -1282, -1272, -1266] },
  { biz: 210, ids: [-1265] },
];

async function correr() {
  await pool.query(`CREATE TABLE IF NOT EXISTS lz_tareas_unicas (
    nombre TEXT PRIMARY KEY, inicio_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fin_at TIMESTAMPTZ, detalle JSONB)`);
  const { rows: marca } = await pool.query(
    `INSERT INTO lz_tareas_unicas (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING RETURNING nombre`, [NOMBRE]);
  if (!marca.length) return;
  console.log(`[tarea-unica] ${NOMBRE}: arranca`);

  const pares = [];
  for (const m of MOVER) pares.push([m.biz, m.original], [m.biz, m.duplicado], ...(m.sumar || []).map((d) => [m.biz, d]));
  for (const b of BORRAR) for (const id of b.ids) pares.push([b.biz, id]);
  const filtro = pares.map(([b, a]) => `(${Number(b)}, ${Number(a)})`).join(', ');
  const negocios = [...new Set(pares.map(([b]) => b))];

  const client = await pool.connect();
  const detalle = { movidas: [], borrados: [], recetasBorradas: [] };
  try {
    await client.query('BEGIN');
    // Respaldo de todo lo que se toca.
    await client.query(`CREATE TABLE IF NOT EXISTS lz_bkp_promodup_recetas_20261112 AS
      SELECT * FROM recetas WHERE (business_id, article_id) IN (${filtro})`);
    await client.query(`CREATE TABLE IF NOT EXISTS lz_bkp_promodup_items_20261112 AS
      SELECT ri.* FROM receta_items ri JOIN recetas r ON r.id = ri.receta_id WHERE (r.business_id, r.article_id) IN (${filtro})`);
    await client.query(`CREATE TABLE IF NOT EXISTS lz_bkp_promodup_app_articles_20261112 AS
      SELECT * FROM app_articles WHERE (business_id, id) IN (${filtro})`);
    await client.query(`CREATE TABLE IF NOT EXISTS lz_bkp_promodup_maxi_articles_20261112 AS
      SELECT * FROM maxi_articles WHERE (business_id, articulo_id) IN (${filtro})`);
    await client.query(`CREATE TABLE IF NOT EXISTS lz_bkp_promodup_agrupaciones_20261112 AS
      SELECT * FROM agrupaciones WHERE business_id = ANY($1::int[])`, [negocios]);

    const { rows: colsRows } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'receta_items'
        AND column_name NOT IN ('id', 'receta_id') ORDER BY ordinal_position`);
    const cols = colsRows.map((c) => `"${c.column_name}"`).join(', ');

    const recetaDe = async (biz, art) => (await client.query(
      `SELECT id FROM recetas WHERE business_id = $1 AND article_id = $2`, [biz, art])).rows[0]?.id ?? null;
    const borrarArticulo = async (biz, id) => {
      const rec = await recetaDe(biz, id);
      if (rec) { await client.query(`DELETE FROM receta_items WHERE receta_id = $1`, [rec]); await client.query(`DELETE FROM recetas WHERE id = $1`, [rec]); detalle.recetasBorradas.push(rec); }
      await client.query(`DELETE FROM app_articles WHERE id = $1 AND business_id = $2`, [id, biz]);
      await client.query(`DELETE FROM maxi_articles WHERE business_id = $1 AND articulo_id = $2`, [biz, id]);
      // Igual que eliminarArticulo: sacarlo de las agrupaciones.
      await client.query(
        `UPDATE agrupaciones
            SET articulos = COALESCE((SELECT jsonb_agg(elem) FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(articulos) = 'array' THEN articulos ELSE '[]'::jsonb END) elem
                 WHERE (elem->>'id')::int IS DISTINCT FROM $2), '[]'::jsonb),
                app_articles_ids = COALESCE((SELECT jsonb_agg(val) FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(app_articles_ids) = 'array' THEN app_articles_ids ELSE '[]'::jsonb END) val
                 WHERE (val)::text::int IS DISTINCT FROM $2), '[]'::jsonb),
                updated_at = NOW()
          WHERE business_id = $1 AND (articulos @> $3::jsonb OR app_articles_ids @> $4::jsonb)`,
        [biz, id, JSON.stringify([{ id }]), JSON.stringify([id])]);
      detalle.borrados.push({ biz, id });
    };

    const aRecalcular = [];
    for (const m of MOVER) {
      const recDup = await recetaDe(m.biz, m.duplicado);
      if (!recDup) continue;
      // Ítems de los otros duplicados que no estén ya (por artículo o insumo).
      for (const otro of m.sumar || []) {
        const recOtro = await recetaDe(m.biz, otro);
        if (!recOtro) continue;
        await client.query(
          `INSERT INTO receta_items (receta_id, ${cols})
           SELECT $1, ${cols} FROM receta_items o
            WHERE o.receta_id = $2
              AND NOT EXISTS (SELECT 1 FROM receta_items y WHERE y.receta_id = $1
                               AND y.article_ref_id IS NOT DISTINCT FROM o.article_ref_id
                               AND y.supply_id IS NOT DISTINCT FROM o.supply_id)`,
          [recDup, recOtro]);
      }
      // La receta vieja del original (vacía o que se contenía a sí misma) se va.
      const recOrig = await recetaDe(m.biz, m.original);
      if (recOrig) { await client.query(`DELETE FROM receta_items WHERE receta_id = $1`, [recOrig]); await client.query(`DELETE FROM recetas WHERE id = $1`, [recOrig]); detalle.recetasBorradas.push(recOrig); }
      const { rows: n } = await client.query(`SELECT nombre FROM maxi_articles WHERE business_id = $1 AND articulo_id = $2`, [m.biz, m.original]);
      await client.query(
        `UPDATE recetas SET article_id = $1, nombre = COALESCE($2, nombre), es_promo = TRUE, active = TRUE, updated_at = NOW() WHERE id = $3`,
        [m.original, n[0]?.nombre ?? null, recDup]);
      // El original nunca dentro de su propia promo.
      await client.query(`DELETE FROM receta_items WHERE receta_id = $1 AND article_ref_id = $2`, [recDup, m.original]);
      aRecalcular.push(recDup);
      detalle.movidas.push({ biz: m.biz, receta: recDup, de: m.duplicado, a: m.original });
      await borrarArticulo(m.biz, m.duplicado);
      for (const otro of m.sumar || []) if (!BORRAR.some((b) => b.biz === m.biz && b.ids.includes(otro))) await borrarArticulo(m.biz, otro);
    }
    for (const b of BORRAR) for (const id of b.ids) await borrarArticulo(b.biz, id);
    await client.query('COMMIT');
    for (const id of aRecalcular) await recalcularCostoReceta(id).catch((e) => console.error(`[tarea-unica] ${NOMBRE} recalculo ${id}:`, e.message));
    await actualizarComponentesDePromos({ businessId: 147 }).catch((e) => console.error(`[tarea-unica] ${NOMBRE} componentes:`, e.message));
    for (const b of negocios) {
      invalidateCacheForBiz(b);
      const borr = detalle.borrados.filter((x) => x.biz === b).length;
      const mov = detalle.movidas.filter((x) => x.biz === b).length;
      avisarAlEquipoSinEsperar({
        businessId: b, type: 'articulo_delete',
        title: `Limpieza: ${borr} promo${borr === 1 ? '' : 's'} duplicada${borr === 1 ? '' : 's'} borrada${borr === 1 ? '' : 's'}${mov ? ` (${mov} pasada${mov === 1 ? '' : 's'} al artículo de MaxiRest)` : ''}`,
        metadata: { kind: 'articulo_delete', scope: 'articulo', ids: detalle.borrados.filter((x) => x.biz === b).map((x) => x.id) },
      });
    }
    detalle.ok = true;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* nada */ }
    detalle.ok = false; detalle.error = e.message;
  } finally {
    client.release();
  }
  await pool.query(`UPDATE lz_tareas_unicas SET fin_at = NOW(), detalle = $2 WHERE nombre = $1`, [NOMBRE, detalle]);
  console.log(`[tarea-unica] ${NOMBRE}: terminada`, JSON.stringify(detalle));
}

function programar() {
  setTimeout(() => { correr().catch((e) => console.error(`[tarea-unica] ${NOMBRE}:`, e.message)); }, 120_000).unref?.();
}

module.exports = { programar, correr };
