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