/* eslint-disable no-console */

const pool = require('../config/db');
const getBusinessIdUtil = require('../utils/getBusinessId');

/* ─── helpers ─────────────────────────────────────────────────── */
function sendError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

// Negocio principal (resuelto por el middleware para subnegocios)
// Se usa para CRUD de grupos: list, create, update, delete, createOrMove
function getPrincipalBizId(req) {
  return getBusinessIdUtil(req);
}

// Negocio original del request (el subnegocio si aplica)
// Se usa solo para validar ownership en operaciones de items (Discontinuados)
function getOriginalBizId(req) {
  if (req._insumosResolvedFrom) return Number(req._insumosResolvedFrom);
  return getBusinessIdUtil(req);
}

// Verifica que el grupo exista — acepta que pertenezca al principal O al subnegocio
// bizPrincipal: negocio principal (resuelto)
// bizOriginal:  negocio del request (puede ser subnegocio)
async function assertGroupMultiBiz(bizPrincipal, bizOriginal, groupId) {
  const ids = [...new Set([bizPrincipal, bizOriginal].filter(Boolean))];
  const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
  const { rowCount } = await pool.query(
    `SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id IN (${placeholders})`,
    [groupId, ...ids]
  );
  return rowCount > 0;
}

/* ─── LIST ───────────────────────────────────────────────────────── */
async function list(req, res) {
  const bizId = getPrincipalBizId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  try {
    const { rows } = await pool.query(
      `SELECT 
        g.id, g.business_id, g.nombre, g.descripcion, g.es_favorita,
        g.created_at, g.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'insumo_id', gi.insumo_id,
              'id', i.id,
              'nombre', i.nombre,
              'codigo_maxi', i.codigo_maxi,
              'unidad_med', i.unidad_med
            )
          ) FILTER (WHERE gi.insumo_id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM insumo_groups g
      LEFT JOIN insumo_group_items gi ON gi.group_id = g.id
      LEFT JOIN insumos i ON i.id = gi.insumo_id
      WHERE g.business_id = $1
      GROUP BY g.id, g.business_id, g.nombre, g.descripcion, g.es_favorita, g.created_at, g.updated_at
      ORDER BY lower(trim(g.nombre))`,
      [bizId]
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('[insumoGroups] list error:', err);
    return sendError(res, 500, 'Error al listar agrupaciones de insumos');
  }
}

/* ─── GET ONE ────────────────────────────────────────────────────── */
async function getOne(req, res) {
  const bizId = getPrincipalBizId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  try {
    const { rows } = await pool.query(
      `SELECT 
        g.id, g.business_id, g.nombre, g.descripcion, g.es_favorita,
        g.created_at, g.updated_at,
        COALESCE(
          json_agg(
            json_build_object('insumo_id', gi.insumo_id, 'id', i.id, 'nombre', i.nombre)
          ) FILTER (WHERE gi.insumo_id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM insumo_groups g
      LEFT JOIN insumo_group_items gi ON gi.group_id = g.id
      LEFT JOIN insumos i ON i.id = gi.insumo_id
      WHERE g.business_id = $1 AND g.id = $2
      GROUP BY g.id, g.business_id, g.nombre, g.descripcion, g.es_favorita, g.created_at, g.updated_at`,
      [bizId, id]
    );
    if (!rows.length) return sendError(res, 404, 'not_found');
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[insumoGroups] getOne error:', err);
    return sendError(res, 500, 'Error al obtener agrupación de insumos');
  }
}

/* ─── CREATE ─────────────────────────────────────────────────────── */
async function create(req, res) {
  const bizId = getPrincipalBizId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');
  const nombre = String(req.body.nombre || '').trim();
  const descripcion = req.body.descripcion ?? null;
  if (!nombre) return sendError(res, 400, 'El nombre es obligatorio');

  try {
    const { rows } = await pool.query(
      `INSERT INTO insumo_groups (business_id, nombre, descripcion)
       VALUES ($1, $2, $3)
       RETURNING id, business_id, nombre, descripcion, es_favorita, created_at, updated_at`,
      [bizId, nombre, descripcion]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[insumoGroups] create error:', err);
    if (err.code === '23505') return sendError(res, 409, 'Ya existe una agrupación con ese nombre');
    return sendError(res, 500, 'Error al crear agrupación de insumos');
  }
}

/* ─── UPDATE ─────────────────────────────────────────────────────── */
async function update(req, res) {
  const bizId = getPrincipalBizId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  const nombre = req.body.nombre != null ? String(req.body.nombre).trim() : null;
  const descripcion = req.body.descripcion ?? null;
  const esFavorita = req.body.es_favorita;
  if (!nombre && descripcion == null && esFavorita == null) return sendError(res, 400, 'Nada para actualizar');

  const sets = [];
  const values = [id, bizId];
  let idx = values.length;

  if (nombre) { idx++; sets.push(`nombre = $${idx}`); values.push(nombre); }
  if (descripcion !== undefined) { idx++; sets.push(`descripcion = $${idx}`); values.push(descripcion); }
  if (esFavorita !== undefined) { idx++; sets.push(`es_favorita = $${idx}`); values.push(Boolean(esFavorita)); }
  sets.push('updated_at = now()');

  try {
    const { rows } = await pool.query(
      `UPDATE insumo_groups SET ${sets.join(', ')} WHERE id = $1 AND business_id = $2
       RETURNING id, business_id, nombre, descripcion, es_favorita, created_at, updated_at`,
      values
    );
    if (!rows.length) return sendError(res, 404, 'not_found');
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[insumoGroups] update error:', err);
    if (err.code === '23505') return sendError(res, 409, 'Ya existe una agrupación con ese nombre');
    return sendError(res, 500, 'Error al actualizar agrupación de insumos');
  }
}

/* ─── DELETE ─────────────────────────────────────────────────────── */
async function remove(req, res) {
  const bizId = getPrincipalBizId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  try {
    const { rowCount } = await pool.query(
      'DELETE FROM insumo_groups WHERE id = $1 AND business_id = $2',
      [id, bizId]
    );
    if (!rowCount) return sendError(res, 404, 'not_found');
    return res.json({ ok: true });
  } catch (err) {
    console.error('[insumoGroups] remove error:', err);
    return sendError(res, 500, 'Error al eliminar agrupación de insumos');
  }
}

/* ─── ITEMS: replace ─────────────────────────────────────────────── */
async function replaceItems(req, res) {
  const bizPrincipal = getPrincipalBizId(req);
  const bizOriginal  = getOriginalBizId(req);
  if (!bizPrincipal) return sendError(res, 400, 'business_id requerido');

  const groupId = Number(req.params.id);
  if (!Number.isFinite(groupId)) return sendError(res, 400, 'ID inválido');

  const insumoIds = (req.body.insumoIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);

  const client = await pool.connect();
  try {
    const ok = await assertGroupMultiBiz(bizPrincipal, bizOriginal, groupId);
    if (!ok) return sendError(res, 404, 'not_found');

    await client.query('BEGIN');
    await client.query('DELETE FROM insumo_group_items WHERE group_id = $1', [groupId]);

    if (insumoIds.length) {
      const values = [];
      const placeholders = [];
      insumoIds.forEach((insumoId, i) => {
        values.push(groupId, insumoId);
        placeholders.push(`($${2*i+1}, $${2*i+2})`);
      });
      await client.query(
        `INSERT INTO insumo_group_items (group_id, insumo_id) VALUES ${placeholders.join(', ')} ON CONFLICT DO NOTHING`,
        values
      );
    }

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[insumoGroups] replaceItems error:', err);
    return sendError(res, 500, 'Error al actualizar items de la agrupación');
  } finally {
    client.release();
  }
}

/* ─── ITEMS: add one ─────────────────────────────────────────────── */
async function addItemToGroup(req, res) {
  const bizPrincipal = getPrincipalBizId(req);
  const bizOriginal  = getOriginalBizId(req);
  if (!bizPrincipal) return sendError(res, 400, 'business_id requerido');

  const groupId  = Number(req.params.id);
  const insumoId = Number(req.body.insumoId);
  if (!Number.isFinite(groupId) || groupId <= 0) return sendError(res, 400, 'IDs inválidos');
  if (!Number.isFinite(insumoId) || insumoId <= 0) return sendError(res, 400, 'IDs inválidos');

  try {
    const ok = await assertGroupMultiBiz(bizPrincipal, bizOriginal, groupId);
    if (!ok) return sendError(res, 404, 'not_found');

    await pool.query(
      `INSERT INTO insumo_group_items (group_id, insumo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [groupId, insumoId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('[insumoGroups] addItemToGroup error:', err);
    return sendError(res, 500, 'Error al agregar insumo a la agrupación');
  }
}

/* ─── ITEMS: bulk add ────────────────────────────────────────────── */
async function addMultipleItemsToGroup(req, res) {
  const bizPrincipal = getPrincipalBizId(req);
  const bizOriginal  = getOriginalBizId(req);
  if (!bizPrincipal) return sendError(res, 400, 'business_id requerido');

  const groupId = Number(req.params.id);
  const insumoIds = Array.isArray(req.body?.insumoIds)
    ? req.body.insumoIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [];

  if (!Number.isFinite(groupId) || groupId <= 0) return sendError(res, 400, 'ID inválido');
  if (!insumoIds.length) return sendError(res, 400, 'Se requiere un array de insumoIds');

  const client = await pool.connect();
  try {
    const ok = await assertGroupMultiBiz(bizPrincipal, bizOriginal, groupId);
    if (!ok) {
      console.error(`[insumoGroups] bulk 404: groupId=${groupId}, bizPrincipal=${bizPrincipal}, bizOriginal=${bizOriginal}`);
      return sendError(res, 404, 'not_found');
    }

    await client.query('BEGIN');
    const params = insumoIds.flatMap((id) => [groupId, id]);
    const valuesSql = insumoIds.map((_, idx) => `($${idx*2+1}, $${idx*2+2})`).join(', ');

    const r = await client.query(
      `INSERT INTO insumo_group_items (group_id, insumo_id) VALUES ${valuesSql} ON CONFLICT DO NOTHING RETURNING insumo_id`,
      params
    );

    await client.query('COMMIT');
    return res.json({ ok: true, added: r.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[insumoGroups] addMultipleItemsToGroup error:', err);
    return sendError(res, 500, err.message || 'Error al agregar insumos en bulk');
  } finally {
    client.release();
  }
}

/* ─── ITEMS: remove ──────────────────────────────────────────────── */
async function removeItemFromGroup(req, res) {
  const bizPrincipal = getPrincipalBizId(req);
  const bizOriginal  = getOriginalBizId(req);
  if (!bizPrincipal) return sendError(res, 400, 'business_id requerido');

  const groupId  = Number(req.params.id);
  const insumoId = Number(req.params.insumoId);
  if (!Number.isFinite(groupId) || groupId <= 0) return sendError(res, 400, 'ID inválido');
  if (!Number.isFinite(insumoId) || insumoId <= 0) return sendError(res, 400, 'ID inválido');

  try {
    const ok = await assertGroupMultiBiz(bizPrincipal, bizOriginal, groupId);
    if (!ok) return sendError(res, 404, 'not_found');

    const r = await pool.query(
      'DELETE FROM insumo_group_items WHERE group_id = $1 AND insumo_id = $2',
      [groupId, insumoId]
    );
    return res.json({ ok: true, removed: r.rowCount || 0 });
  } catch (err) {
    console.error('[insumoGroups] removeItemFromGroup error:', err);
    return sendError(res, 500, err.message || 'Error al quitar insumo de la agrupación');
  }
}

/* ─── EXCLUSIONES ────────────────────────────────────────────────── */
async function getExclusions(req, res) {
  const bizId = getPrincipalBizId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  try {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2',
      [id, bizId]
    );
    if (!rowCount) return sendError(res, 404, 'not_found');

    const { rows } = await pool.query(
      'SELECT id, scope, ref_id FROM insumo_group_exclusions WHERE group_id = $1 ORDER BY created_at DESC',
      [id]
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('[insumoGroups] getExclusions error:', err);
    return sendError(res, 500, 'Error al obtener exclusiones');
  }
}

async function addExclusions(req, res) {
  const bizId = getPrincipalBizId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  const { exclusions } = req.body;
  if (!Array.isArray(exclusions) || !exclusions.length) return sendError(res, 400, 'exclusions debe ser un array no vacío');

  try {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2', [id, bizId]
    );
    if (!rowCount) return sendError(res, 404, 'not_found');

    const values = [];
    const placeholders = [];
    exclusions.forEach((e, idx) => {
      const refId = Number(e.ref_id);
      if (!Number.isFinite(refId)) return;
      const base = idx * 3;
      values.push(id, e.scope || 'insumo', refId);
      placeholders.push(`($${base+1}, $${base+2}, $${base+3})`);
    });
    if (!placeholders.length) return sendError(res, 400, 'No hay exclusiones válidas');

    await pool.query(
      `INSERT INTO insumo_group_exclusions (group_id, scope, ref_id) VALUES ${placeholders.join(', ')} ON CONFLICT DO NOTHING`,
      values
    );
    return res.json({ ok: true, count: placeholders.length });
  } catch (err) {
    console.error('[insumoGroups] addExclusions error:', err);
    return sendError(res, 500, 'Error al agregar exclusiones');
  }
}

async function removeExclusions(req, res) {
  const bizId = getPrincipalBizId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  const { ids, scope = 'insumo' } = req.body;
  if (!Array.isArray(ids) || !ids.length) return sendError(res, 400, 'ids debe ser un array no vacío');

  try {
    const { rowCount: groupCount } = await pool.query(
      'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2', [id, bizId]
    );
    if (!groupCount) return sendError(res, 404, 'not_found');

    const refIds = ids.map(Number).filter(Number.isFinite);
    if (!refIds.length) return sendError(res, 400, 'No hay IDs válidos');

    const placeholders = refIds.map((_, i) => `$${i+3}`).join(', ');
    const { rowCount } = await pool.query(
      `DELETE FROM insumo_group_exclusions WHERE group_id = $1 AND scope = $2 AND ref_id IN (${placeholders})`,
      [id, scope, ...refIds]
    );
    return res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    console.error('[insumoGroups] removeExclusions error:', err);
    return sendError(res, 500, 'Error al quitar exclusiones');
  }
}

/* ─── CREATE OR MOVE ─────────────────────────────────────────────── */
async function createOrMove(req, res) {
  const bizId = getPrincipalBizId(req);
  console.log('[createOrMove] bizId:', bizId, '| body.nombre:', req.body?.nombre, '| ids.length:', (req.body?.ids || []).length);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const nombre = String(req.body?.nombre || '').trim();
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!nombre || !ids.length) return sendError(res, 400, 'Nombre e IDs son obligatorios');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let destRow;
    const existing = await client.query(
      'SELECT id, nombre FROM insumo_groups WHERE business_id = $1 AND nombre = $2 FOR UPDATE',
      [bizId, nombre]
    );
    if (existing.rows.length) {
      destRow = existing.rows[0];
    } else {
      const inserted = await client.query(
        'INSERT INTO insumo_groups (business_id, nombre) VALUES ($1, $2) RETURNING id, nombre',
        [bizId, nombre]
      );
      destRow = inserted.rows[0];
    }

    const destId = Number(destRow.id);

    // Quitar esos insumos de OTROS grupos del mismo negocio
    await client.query(
      `DELETE FROM insumo_group_items
       WHERE group_id IN (SELECT id FROM insumo_groups WHERE business_id = $1 AND id != $2)
       AND insumo_id = ANY($3::int[])`,
      [bizId, destId, ids]
    );

    // Insertar en el grupo destino
    const values = ids.flatMap((insumoId) => [destId, insumoId]);
    const placeholders = ids.map((_, i) => `($${2*i+1}, $${2*i+2})`).join(', ');
    await client.query(
      `INSERT INTO insumo_group_items (group_id, insumo_id) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      values
    );

    await client.query('COMMIT');
    console.log(`✅ [createOrMove] "${nombre}" (ID: ${destId}) con ${ids.length} insumos`);
    return res.json({ ok: true, id: destId, nombre, moved: ids.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[insumoGroups] createOrMove error:', err);
    return sendError(res, 500, 'Error al crear/mover agrupación');
  } finally {
    client.release();
  }
}

module.exports = {
  list, getOne, create, update, remove,
  replaceItems,
  addItemToGroup, addMultipleItemsToGroup, removeItemFromGroup,
  getExclusions, addExclusions, removeExclusions,
  createOrMove,
};