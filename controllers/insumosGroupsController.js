/* eslint-disable no-console */

const pool = require('../config/db');
const getBusinessId = require('../utils/getBusinessId');

/* =============== helpers básicos =============== */
function sendError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

async function assertGroup(bizId, groupId) {
  await client.query('BEGIN');

const { rowCount } = await client.query(
  'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2',
  [groupId, bizId]
);
if (!rowCount) {
  await client.query('ROLLBACK');
  return sendError(res, 404, 'not_found');
}

}

/* =============== LISTAR GRUPOS =============== */
async function list(req, res) {
  console.log('🚀🚀🚀 [NUEVA VERSION] insumoGroups.list called 🚀🚀🚀');
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  try {
    const { rows } = await pool.query(
      `
      SELECT 
        g.id,
        g.business_id,
        g.nombre,
        g.descripcion,
        g.es_favorita,
        g.created_at,
        g.updated_at,
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
      LEFT JOIN insumo_group_items gi
        ON gi.group_id = g.id
      LEFT JOIN insumos i
        ON i.id = gi.insumo_id
      WHERE g.business_id = $1
      GROUP BY 
        g.id,
        g.business_id,
        g.nombre,
        g.descripcion,
        g.es_favorita,
        g.created_at,
        g.updated_at
      ORDER BY lower(trim(g.nombre))
      `,
      [bizId]
    );

    console.log('📋 [insumoGroups.list] Grupos:', rows.length);
    if (rows.length > 0) {
      rows.forEach((g, idx) => {
        console.log(`📋 [insumoGroups.list] Grupo ${idx + 1}/${rows.length}:`, {
          id: g.id,
          nombre: g.nombre,
          itemsCount: g.items?.length || 0,
          firstItem: g.items?.[0],
        });
      });
    }

    return res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('[insumoGroups] list error:', err);
    return sendError(res, 500, 'Error al listar agrupaciones de insumos');
  }
}

/* =============== OBTENER UNO =============== */
async function getOne(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  try {
    const { rows } = await pool.query(
      `
      SELECT 
        g.id,
        g.business_id,
        g.nombre,
        g.descripcion,
        g.es_favorita,
        g.created_at,
        g.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'insumo_id', gi.insumo_id,
              'id', i.id,
              'nombre', i.nombre
            )
          ) FILTER (WHERE gi.insumo_id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM insumo_groups g
      LEFT JOIN insumo_group_items gi
        ON gi.group_id = g.id
      LEFT JOIN insumos i
        ON i.id = gi.insumo_id
      WHERE g.business_id = $1
        AND g.id = $2
      GROUP BY 
        g.id,
        g.business_id,
        g.nombre,
        g.descripcion,
        g.es_favorita,
        g.created_at,
        g.updated_at
      `,
      [bizId, id]
    );

    if (!rows.length) return sendError(res, 404, 'not_found');
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[insumoGroups] getOne error:', err);
    return sendError(res, 500, 'Error al obtener agrupación de insumos');
  }
}

/* =============== CREAR / EDITAR / BORRAR GRUPO =============== */
async function create(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const nombre = String(req.body.nombre || '').trim();
  const descripcion = req.body.descripcion ?? null;
  if (!nombre) return sendError(res, 400, 'El nombre es obligatorio');

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO insumo_groups (business_id, nombre, descripcion)
      VALUES ($1, $2, $3)
      RETURNING id, business_id, nombre, descripcion, es_favorita,
                created_at, updated_at
      `,
      [bizId, nombre, descripcion]
    );

    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[insumoGroups] create error:', err);
    if (err.code === '23505') {
      return sendError(res, 409, 'Ya existe una agrupación con ese nombre');
    }
    return sendError(res, 500, 'Error al crear agrupación de insumos');
  }
}

async function update(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  const nombre = req.body.nombre != null ? String(req.body.nombre).trim() : null;
  const descripcion = req.body.descripcion ?? null;
  const esFavorita = req.body.es_favorita;

  if (!nombre && descripcion == null && esFavorita == null) {
    return sendError(res, 400, 'Nada para actualizar');
  }

  const sets = [];
  const values = [id, bizId];
  let idx = values.length;

  if (nombre != null && nombre !== '') {
    idx += 1;
    sets.push(`nombre = $${idx}`);
    values.push(nombre);
  }
  if (descripcion !== undefined) {
    idx += 1;
    sets.push(`descripcion = $${idx}`);
    values.push(descripcion);
  }
  if (esFavorita !== undefined) {
    idx += 1;
    sets.push(`es_favorita = $${idx}`);
    values.push(Boolean(esFavorita));
  }
  sets.push('updated_at = now()');

  try {
    const { rows } = await pool.query(
      `
      UPDATE insumo_groups
      SET ${sets.join(', ')}
      WHERE id = $1 AND business_id = $2
      RETURNING id, business_id, nombre, descripcion, es_favorita,
                created_at, updated_at
      `,
      values
    );

    if (!rows.length) return sendError(res, 404, 'not_found');
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[insumoGroups] update error:', err);
    if (err.code === '23505') {
      return sendError(res, 409, 'Ya existe una agrupación con ese nombre');
    }
    return sendError(res, 500, 'Error al actualizar agrupación de insumos');
  }
}

async function remove(req, res) {
  const bizId = getBusinessId(req);
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
    return sendError(res, 500, 'Error al eliminar la agrupación de insumos');
  }
}

/* =============== ITEMS: replace / add / bulk / remove =============== */
/**
 * PUT /groups/:id/items  body: { insumoIds: [] }
 * (Reemplaza por completo el set de items)
 */
async function replaceItems(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const groupId = Number(req.params.id);
  if (!Number.isFinite(groupId)) return sendError(res, 400, 'ID inválido');

  const insumoIds = (req.body.insumoIds || [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

  const client = await pool.connect();
  try {
    const okGroup = await assertGroup(bizId, groupId);
    if (!okGroup) return sendError(res, 404, 'not_found');

    await client.query('BEGIN');

    await client.query('DELETE FROM insumo_group_items WHERE group_id = $1', [groupId]);

    if (insumoIds.length) {
      const values = [];
      const placeholders = [];
      insumoIds.forEach((insumoId, i) => {
        values.push(groupId, insumoId);
        const p1 = 2 * i + 1;
        const p2 = 2 * i + 2;
        placeholders.push(`($${p1}, $${p2})`);
      });

      await client.query(
        `
        INSERT INTO insumo_group_items (group_id, insumo_id)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (group_id, insumo_id) DO NOTHING
        `,
        values
      );
    }

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    console.error('[insumoGroups] replaceItems error:', err);
    await client.query('ROLLBACK').catch(() => {});
    return sendError(res, 500, 'Error al actualizar items de la agrupación');
  } finally {
    client.release();
  }
}

/**
 * POST /groups/:id/items  body: { insumoId }
 */
async function addItemToGroup(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const groupId = Number(req.params.id);
  const insumoId = Number(req.body.insumoId);

  if (!Number.isFinite(groupId) || groupId <= 0) return sendError(res, 400, 'IDs inválidos');
  if (!Number.isFinite(insumoId) || insumoId <= 0) return sendError(res, 400, 'IDs inválidos');

  try {
    const okGroup = await assertGroup(bizId, groupId);
    if (!okGroup) return sendError(res, 404, 'not_found');

    await pool.query(
      `
      INSERT INTO insumo_group_items (group_id, insumo_id)
      VALUES ($1, $2)
      ON CONFLICT (group_id, insumo_id) DO NOTHING
      `,
      [groupId, insumoId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('[insumoGroups] addItemToGroup error:', err);
    return sendError(res, 500, 'Error al agregar insumo a la agrupación');
  }
}

/**
 * POST /groups/:id/items/bulk  body: { insumoIds: [] }
 */
async function addMultipleItemsToGroup(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const groupId = Number(req.params.id);
  const insumoIds = Array.isArray(req.body?.insumoIds)
    ? req.body.insumoIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [];

  if (!Number.isFinite(groupId) || groupId <= 0) return sendError(res, 400, 'ID inválido');
  if (!insumoIds.length) return sendError(res, 400, 'Se requiere un array de insumoIds');

  const client = await pool.connect();
  try {
    const okGroup = await assertGroup(bizId, groupId);
    if (!okGroup) return sendError(res, 404, 'not_found');

    await client.query('BEGIN');

    const valuesSql = insumoIds
      .map((_, idx) => {
        const p1 = idx * 2 + 1;
        const p2 = idx * 2 + 2;
        return `($${p1}, $${p2})`;
      })
      .join(', ');

    const params = insumoIds.flatMap((id) => [groupId, id]);

    const r = await client.query(
      `
      INSERT INTO insumo_group_items (group_id, insumo_id)
      VALUES ${valuesSql}
      ON CONFLICT (group_id, insumo_id) DO NOTHING
      RETURNING insumo_id
      `,
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

/**
 * DELETE /groups/:id/items/:insumoId
 * ✅ idempotente: si no está, igual ok:true
 */
async function removeItemFromGroup(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const groupId = Number(req.params.id);
  const insumoId = Number(req.params.insumoId);

  if (!Number.isFinite(groupId) || groupId <= 0) return sendError(res, 400, 'ID inválido');
  if (!Number.isFinite(insumoId) || insumoId <= 0) return sendError(res, 400, 'ID inválido');

  try {
    // 1) valida que el grupo es de este business
    const ok = await pool.query(
      'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2',
      [groupId, bizId]
    );
    if (!ok.rowCount) return sendError(res, 404, 'not_found');

    // 2) delete idempotente
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

/* =============== EXCLUSIONES =============== */
async function getExclusions(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  try {
    const { rowCount: groupCount } = await pool.query(
      'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2',
      [id, bizId]
    );
    if (!groupCount) return sendError(res, 404, 'not_found');

    const { rows } = await pool.query(
      `
      SELECT id, scope, ref_id
      FROM insumo_group_exclusions
      WHERE group_id = $1
      ORDER BY created_at DESC
      `,
      [id]
    );

    return res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('[insumoGroups] getExclusions error:', err);
    return sendError(res, 500, 'Error al obtener exclusiones');
  }
}

async function addExclusions(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  const { exclusions } = req.body;
  if (!Array.isArray(exclusions) || !exclusions.length) {
    return sendError(res, 400, 'exclusions debe ser un array no vacío');
  }

  try {
    const { rowCount: groupCount } = await pool.query(
      'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2',
      [id, bizId]
    );
    if (!groupCount) return sendError(res, 404, 'not_found');

    const values = [];
    const placeholders = [];

    exclusions.forEach((e, idx) => {
      const scope = e.scope || 'insumo';
      const refId = Number(e.ref_id);
      if (!Number.isFinite(refId)) return;

      const base = idx * 3;
      values.push(id, scope, refId);
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    });

    if (!placeholders.length) return sendError(res, 400, 'No hay exclusiones válidas para agregar');

    await pool.query(
      `
      INSERT INTO insumo_group_exclusions (group_id, scope, ref_id)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (group_id, scope, ref_id) DO NOTHING
      `,
      values
    );

    return res.json({ ok: true, count: placeholders.length });
  } catch (err) {
    console.error('[insumoGroups] addExclusions error:', err);
    return sendError(res, 500, 'Error al agregar exclusiones');
  }
}

async function removeExclusions(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  const { ids, scope = 'insumo' } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return sendError(res, 400, 'ids debe ser un array no vacío');
  }

  try {
    const { rowCount: groupCount } = await pool.query(
      'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2',
      [id, bizId]
    );
    if (!groupCount) return sendError(res, 404, 'not_found');

    const refIds = ids.map(Number).filter(Number.isFinite);
    if (!refIds.length) return sendError(res, 400, 'No hay IDs válidos para eliminar');

    const placeholders = refIds.map((_, idx) => `$${idx + 3}`).join(', ');

    const { rowCount } = await pool.query(
      `
      DELETE FROM insumo_group_exclusions
      WHERE group_id = $1
        AND scope = $2
        AND ref_id IN (${placeholders})
      `,
      [id, scope, ...refIds]
    );

    return res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    console.error('[insumoGroups] removeExclusions error:', err);
    return sendError(res, 500, 'Error al quitar exclusiones');
  }
}

/* =============== CREATE OR MOVE =============== */
async function createOrMove(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const nombre = String(req.body?.nombre || '').trim();
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!nombre || !ids.length) {
    return sendError(res, 400, 'Nombre e IDs son obligatorios');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let destRow;
    {
      const r = await client.query(
        `
        SELECT id, nombre
        FROM insumo_groups
        WHERE business_id = $1 AND nombre = $2
        FOR UPDATE
        `,
        [bizId, nombre]
      );

      if (r.rows.length) {
        destRow = r.rows[0];
      } else {
        const r2 = await client.query(
          `
          INSERT INTO insumo_groups (business_id, nombre)
          VALUES ($1, $2)
          RETURNING id, nombre
          `,
          [bizId, nombre]
        );
        destRow = r2.rows[0];
      }
    }

    const destId = Number(destRow.id);

    await client.query(
      `
      DELETE FROM insumo_group_items
      WHERE group_id IN (
        SELECT id FROM insumo_groups WHERE business_id = $1 AND id != $2
      )
      AND insumo_id = ANY($3::int[])
      `,
      [bizId, destId, ids]
    );

    const values = [];
    const placeholders = [];
    ids.forEach((insumoId, i) => {
      values.push(destId, insumoId);
      const p1 = 2 * i + 1;
      const p2 = 2 * i + 2;
      placeholders.push(`($${p1}, $${p2})`);
    });

    await client.query(
      `
      INSERT INTO insumo_group_items (group_id, insumo_id)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (group_id, insumo_id) DO NOTHING
      `,
      values
    );

    await client.query('COMMIT');

    console.log(`✅ [createOrMove] Agrupación "${nombre}" (ID: ${destId}) con ${ids.length} insumos`);
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
  list,
  getOne,
  create,
  update,
  remove,

  replaceItems,

  // ✅ nombres “de ruta” (claros)
  addItemToGroup,
  addMultipleItemsToGroup,
  removeItemFromGroup,

  getExclusions,
  addExclusions,
  removeExclusions,

  createOrMove,
};
