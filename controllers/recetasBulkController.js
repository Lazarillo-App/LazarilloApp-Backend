// controllers/recetasBulkController.js
'use strict';

const pool = require('../config/db');
const getBusinessId = require('../utils/getBusinessId');

/**
 * Resuelve los article_id de una agrupación leyendo tanto
 * el JSONB `articulos` como el array `app_articles_ids`.
 */
async function getArticleIdsFromAgrupacion(client, bizId, agrupacionId) {
  const { rows } = await client.query(
    `SELECT articulos, app_articles_ids
       FROM agrupaciones
      WHERE id = $1 AND business_id = $2`,
    [agrupacionId, bizId]
  );
  if (!rows.length) return [];

  const ids = new Set();

  // articulos JSONB: array de objetos { id, ... }
  const arts = rows[0].articulos;
  if (Array.isArray(arts)) {
    for (const a of arts) {
      const id = Number(a?.id ?? a?.articulo_id ?? a);
      if (Number.isFinite(id) && id !== 0) ids.add(id);
    }
  }

  // app_articles_ids: array de números
  const appIds = rows[0].app_articles_ids;
  if (Array.isArray(appIds)) {
    for (const raw of appIds) {
      const id = Number(raw);
      if (Number.isFinite(id) && id !== 0) ids.add(id);
    }
  }

  return Array.from(ids);
}

/**
 * Resuelve los insumo_id de un grupo de insumos.
 */
async function getInsumoIdsFromGroup(client, bizId, groupId) {
  const { rows } = await client.query(
    `SELECT gi.insumo_id
       FROM insumo_group_items gi
       JOIN insumo_groups g ON g.id = gi.group_id
      WHERE g.id = $1 AND g.business_id = $2`,
    [groupId, bizId]
  );
  return rows.map(r => Number(r.insumo_id)).filter(n => Number.isFinite(n) && n !== 0);
}

/**
 * GET /api/businesses/:businessId/recetas/bulk-preview
 * Query: ?tipo=articulo|elaborado&filtroScope=all|agrupacion&agrupacionId=N
 * Devuelve { count } para mostrar en el modal antes de confirmar.
 */
exports.previewBulkDelete = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const bizId = getBusinessId(req);
    if (!bizId) return res.status(400).json({ ok: false, error: 'business_id_requerido' });

    const { tipo, filtroScope = 'all', agrupacionId } = req.query;
    if (!['articulo', 'elaborado'].includes(tipo)) {
      return res.status(400).json({ ok: false, error: 'tipo_invalido' });
    }

    const conditions = [`business_id = $1`, `active = TRUE`];
    const params = [bizId];

    if (tipo === 'articulo') {
      conditions.push(`article_id IS NOT NULL`);
    } else {
      conditions.push(`insumo_id IS NOT NULL`);
    }

    if (filtroScope === 'agrupacion') {
      const agrupId = Number(agrupacionId);
      if (!Number.isFinite(agrupId)) {
        return res.status(400).json({ ok: false, error: 'agrupacion_id_requerido' });
      }

      let ids;
      if (tipo === 'articulo') {
        ids = await getArticleIdsFromAgrupacion(client, bizId, agrupId);
        if (!ids.length) return res.json({ ok: true, count: 0 });
        params.push(ids);
        conditions.push(`article_id = ANY($${params.length}::int[])`);
      } else {
        ids = await getInsumoIdsFromGroup(client, bizId, agrupId);
        if (!ids.length) return res.json({ ok: true, count: 0 });
        params.push(ids);
        conditions.push(`insumo_id = ANY($${params.length}::int[])`);
      }
    }

    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM recetas
        WHERE ${conditions.join(' AND ')}`,
      params
    );

    return res.json({ ok: true, count: rows[0].count });
  } catch (e) {
    console.error('[previewBulkDelete]', e);
    next(e);
  } finally {
    client.release();
  }
};

/**
 * DELETE /api/businesses/:businessId/recetas/bulk
 * Body: { tipo, filtroScope, agrupacionId? }
 */
exports.bulkDelete = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const bizId = getBusinessId(req);
    if (!bizId) return res.status(400).json({ ok: false, error: 'business_id_requerido' });

    const { tipo, filtroScope = 'all', agrupacionId } = req.body || {};
    if (!['articulo', 'elaborado'].includes(tipo)) {
      return res.status(400).json({ ok: false, error: 'tipo_invalido' });
    }

    await client.query('BEGIN');

    const conditions = [`business_id = $1`];
    const params = [bizId];

    if (tipo === 'articulo') {
      conditions.push(`article_id IS NOT NULL`);
    } else {
      conditions.push(`insumo_id IS NOT NULL`);
    }

    if (filtroScope === 'agrupacion') {
      const agrupId = Number(agrupacionId);
      if (!Number.isFinite(agrupId)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'agrupacion_id_requerido' });
      }

      let ids;
      if (tipo === 'articulo') {
        ids = await getArticleIdsFromAgrupacion(client, bizId, agrupId);
      } else {
        ids = await getInsumoIdsFromGroup(client, bizId, agrupId);
      }

      if (!ids.length) {
        await client.query('COMMIT');
        return res.json({ ok: true, deleted: 0 });
      }

      params.push(ids);
      conditions.push(
        tipo === 'articulo'
          ? `article_id = ANY($${params.length}::int[])`
          : `insumo_id = ANY($${params.length}::int[])`
      );
    }

    const { rowCount } = await client.query(
      `DELETE FROM recetas WHERE ${conditions.join(' AND ')}`,
      params
    );

    await client.query('COMMIT');
    console.log(`[recetas/bulk] business=${bizId} tipo=${tipo} scope=${filtroScope} deleted=${rowCount}`);

    return res.json({ ok: true, deleted: rowCount });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[bulkDelete]', e);
    next(e);
  } finally {
    client.release();
  }
};

/**
 * POST /api/businesses/:businessId/recetas/bulk-add-insumo
 * Body: { articleIds: number[], insumoId: number, cantidad: number, unidad: string }
 *
 * Agrega un insumo a las recetas de todos los artículos indicados:
 * - Si el artículo tiene receta activa y NO tiene el insumo → agrega el item.
 * - Si ya tiene el insumo → saltea (nunca duplica).
 * - Si no tiene receta → crea una receta mínima con ese único item.
 * Recalcula costo_total de cada receta tocada.
 */
exports.bulkAddInsumo = async (req, res, next) => {
  const bizId = getBusinessId(req);
  if (!bizId) return res.status(400).json({ ok: false, error: 'Business ID requerido' });

  const { articleIds, insumoId, cantidad = 0, unidad = null } = req.body || {};
  const ids = (Array.isArray(articleIds) ? articleIds : [])
    .map(Number).filter(n => Number.isFinite(n) && n !== 0);
  const insId = Number(insumoId);

  if (!ids.length) return res.status(400).json({ ok: false, error: 'articleIds requerido' });
  if (!Number.isFinite(insId) || insId === 0) {
    return res.status(400).json({ ok: false, error: 'insumoId requerido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Datos del insumo (precio y unidad base para costo_unitario)
    const { rows: insRows } = await client.query(
      `SELECT id, nombre, unidad_med, precio_ref, codigo_maxi
         FROM insumos
        WHERE id = $1 AND business_id = $2`,
      [insId, bizId]
    );
    if (!insRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }
    const insumo = insRows[0];

    // Conversión simple de unidades (kg↔gr, l↔ml). Mismo criterio que el front.
    const normU = (u) => String(u || 'u').trim().toLowerCase()
      .replace('grs', 'gr').replace('gramos', 'gr').replace('kilo', 'kg').replace('kgs', 'kg')
      .replace('litro', 'l').replace('lt', 'l').replace('cc', 'ml');
    const factorTo = (from, to) => {
      const f = normU(from), t = normU(to);
      if (f === t) return 1;
      if (f === 'kg' && t === 'gr') return 1000;
      if (f === 'gr' && t === 'kg') return 1 / 1000;
      if (f === 'l' && t === 'ml') return 1000;
      if (f === 'ml' && t === 'l') return 1 / 1000;
      return 1; // unidades incompatibles: sin conversión
    };
    const unidadItem = unidad || insumo.unidad_med || 'u';
    const precioRef = Number(insumo.precio_ref) || 0;
    // precio por 1 unidad elegida = precio_ref (en unidad base) / factor(base→elegida)
    const factor = factorTo(insumo.unidad_med || 'u', unidadItem);
    const costoUnitario = factor > 0 ? precioRef / factor : precioRef;

    const cant = Number(cantidad) || 0;

    let agregados = 0, salteados = 0, recetasCreadas = 0;

    for (const artId of ids) {
      // Receta activa del artículo
      const { rows: recRows } = await client.query(
        `SELECT id FROM recetas
          WHERE article_id = $1 AND business_id = $2 AND active = TRUE
          LIMIT 1`,
        [artId, bizId]
      );

      let recetaId;
      if (recRows.length) {
        recetaId = recRows[0].id;
        // ¿Ya tiene el insumo?
        const { rows: existRows } = await client.query(
          `SELECT 1 FROM receta_items WHERE receta_id = $1 AND insumo_id = $2 LIMIT 1`,
          [recetaId, insId]
        );
        if (existRows.length) { salteados++; continue; }
      } else {
        // Crear receta mínima
        const { rows: newRec } = await client.query(
          `INSERT INTO recetas
             (article_id, business_id, nombre, porciones, porcentaje_venta,
              costo_total, active, origen, created_at, updated_at)
           VALUES ($1, $2, NULL, 1, 0, 0, TRUE, 'bulk', NOW(), NOW())
           RETURNING id`,
          [artId, bizId]
        );
        recetaId = newRec.rows[0].id;
        recetasCreadas++;
      }

      // Insertar item al final
      await client.query(
        `INSERT INTO receta_items
           (receta_id, insumo_id, cantidad, unidad, costo_unitario,
            codigo_maxi_insumo, nombre_insumo_maxi, tipo_costo, merma, pedido, orden)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'total', TRUE, TRUE,
           COALESCE((SELECT MAX(orden) + 1 FROM receta_items WHERE receta_id = $1), 0))`,
        [recetaId, insId, cant, unidadItem,
         Math.round(costoUnitario * 10000) / 10000,
         insumo.codigo_maxi || null, insumo.nombre || null]
      );

      // Recalcular costo_total de la receta
      await client.query(
        `UPDATE recetas r
            SET costo_total = COALESCE((
                  SELECT SUM(ri.cantidad * ri.costo_unitario)
                    FROM receta_items ri
                   WHERE ri.receta_id = r.id
                     AND ri.tipo_costo != 'nulo'
                     AND ri.cantidad > 0
                ), 0),
                updated_at = NOW()
          WHERE r.id = $1`,
        [recetaId]
      );

      agregados++;
    }

    await client.query('COMMIT');
    return res.json({ ok: true, agregados, salteados, recetasCreadas, insumo: insumo.nombre });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[bulkAddInsumo]', e);
    next(e);
  } finally {
    client.release();
  }
}