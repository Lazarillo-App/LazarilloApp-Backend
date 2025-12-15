/* eslint-disable no-console */
const pool = require('../config/db');

/* =============== OBTENER BUSINESS =============== */
function getBusinessId(req) {
  const hdr =
    req.header('X-Business-Id') ||
    req.header('X-Business') ||
    req.headers['x-business-id'] ||
    req.headers['x-business'] ||
    req.query.businessId;

  if (hdr != null && hdr !== '') {
    const n = Number(hdr);
    if (Number.isFinite(n) && n > 0) return n;
  }

  if (req.business && req.business.id) {
    const n = Number(req.business.id);
    if (Number.isFinite(n) && n > 0) return n;
  }

  if (req.user && req.user.active_business_id) {
    const n = Number(req.user.active_business_id);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return null;
}

/* =============== helpers básicos =============== */
function sendError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

/* =============== LISTAR GRUPOS =============== */
/**
 * GET /api/insumos/groups
 * Devuelve todas las agrupaciones del negocio, con los insumos de cada una en `items`
 */
async function list(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) {
    return sendError(res, 400, 'business_id requerido');
  }

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
            CASE
              WHEN i.id IS NOT NULL THEN row_to_json(i)
              ELSE NULL
            END
          ) FILTER (WHERE i.id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM insumo_groups g
      LEFT JOIN insumo_group_items gi
        ON gi.group_id = g.id
      LEFT JOIN insumos i
        ON i.id = gi.insumo_id
       AND i.business_id = g.business_id
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

    return res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('[insumoGroups] list error:', err);
    return sendError(res, 500, 'Error al listar agrupaciones de insumos');
  }
}

/* =============== OBTENER UNO =============== */
/**
 * GET /api/insumos/groups/:id
 * Devuelve una agrupación con sus insumos completos en `items`
 */
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
            CASE
              WHEN i.id IS NOT NULL THEN row_to_json(i)
              ELSE NULL
            END
          ) FILTER (WHERE i.id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM insumo_groups g
      LEFT JOIN insumo_group_items gi
        ON gi.group_id = g.id
      LEFT JOIN insumos i
        ON i.id = gi.insumo_id
       AND i.business_id = g.business_id
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

/* =============== CREAR GRUPO =============== */
// POST /api/insumos/groups
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

    // UNIQUE: mismo nombre en el mismo negocio
    if (err.code === '23505') {
      return sendError(res, 409, 'Ya existe una agrupación con ese nombre');
    }

    return sendError(res, 500, 'Error al crear agrupación de insumos');
  }
}

/* =============== ACTUALIZAR GRUPO =============== */
// PUT /api/insumos/groups/:id
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

/* =============== REEMPLAZAR ITEMS (bulk) =============== */
// PUT /api/insumos/groups/:id/items
// body: { insumoIds: number[] }
async function replaceItems(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  const insumoIds = (req.body.insumoIds || [])
    .map(Number)
    .filter((n) => Number.isFinite(n));

  try {
    // chequear que el grupo pertenece al negocio
    const { rowCount: groupCount } = await pool.query(
      'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2',
      [id, bizId]
    );
    if (!groupCount) return sendError(res, 404, 'not_found');

    await pool.query('BEGIN');

    // limpiar items previos
    await pool.query('DELETE FROM insumo_group_items WHERE group_id = $1', [
      id,
    ]);

    // insertar nuevos (si hay)
    if (insumoIds.length) {
      const values = [];
      const placeholders = [];
      insumoIds.forEach((insumoId, i) => {
        values.push(id, insumoId);
        const p1 = 2 * i + 1;
        const p2 = 2 * i + 2;
        placeholders.push(`($${p1}, $${p2})`);
      });

      await pool.query(
        `
        INSERT INTO insumo_group_items (group_id, insumo_id)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (group_id, insumo_id) DO NOTHING
        `,
        values
      );
    }

    await pool.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    console.error('[insumoGroups] replaceItems error:', err);
    await pool.query('ROLLBACK').catch(() => {});
    return sendError(res, 500, 'Error al actualizar items de la agrupación');
  }
}

/* =============== AGREGAR UN ITEM =============== */
// POST /api/insumos/groups/:id/items
// body: { insumoId }
async function addItem(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const groupId = Number(req.params.id);
  const insumoId = Number(req.body.insumoId);

  if (!Number.isFinite(groupId) || !Number.isFinite(insumoId)) {
    return sendError(res, 400, 'IDs inválidos');
  }

  try {
    // validar que el grupo sea del negocio
    const { rowCount: groupCount } = await pool.query(
      'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2',
      [groupId, bizId]
    );
    if (!groupCount) return sendError(res, 404, 'not_found');

    // opcional: validar que el insumo también pertenezca al negocio
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
    console.error('[insumoGroups] addItem error:', err);
    return sendError(res, 500, 'Error al agregar insumo a la agrupación');
  }
}

/* =============== QUITAR UN ITEM =============== */
// DELETE /api/insumos/groups/:id/items/:insumoId
async function removeItem(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const groupId = Number(req.params.id);
  const insumoId = Number(req.params.insumoId);

  if (!Number.isFinite(groupId) || !Number.isFinite(insumoId)) {
    return sendError(res, 400, 'IDs inválidos');
  }

  try {
    // validar que el grupo sea del negocio
    const { rowCount: groupCount } = await pool.query(
      'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2',
      [groupId, bizId]
    );
    if (!groupCount) return sendError(res, 404, 'not_found');

    await pool.query(
      'DELETE FROM insumo_group_items WHERE group_id = $1 AND insumo_id = $2',
      [groupId, insumoId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('[insumoGroups] removeItem error:', err);
    return sendError(res, 500, 'Error al quitar insumo de la agrupación');
  }
}

/* =============== ELIMINAR GRUPO =============== */
// DELETE /api/insumos/groups/:id
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

async function getExclusions(req, res) {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  try {
    // Verificar que el grupo existe y pertenece al negocio
    const { rowCount: groupCount } = await pool.query(
      'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2',
      [id, bizId]
    );
    if (!groupCount) return sendError(res, 404, 'not_found');

    // Obtener exclusiones
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

/**
 * POST /api/insumos/groups/:id/exclusions
 * Agregar exclusiones (quitar insumos del TODO)
 * Body: { exclusions: [{ scope: 'insumo', ref_id: 123 }, ...] }
 */
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
    // Verificar que el grupo existe
    const { rowCount: groupCount } = await pool.query(
      'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2',
      [id, bizId]
    );
    if (!groupCount) return sendError(res, 404, 'not_found');

    // Preparar valores para INSERT
    const values = [];
    const placeholders = [];
    
    exclusions.forEach((e, idx) => {
      const scope = e.scope || 'insumo';
      const refId = Number(e.ref_id);
      
      if (!Number.isFinite(refId)) return; // skip inválidos
      
      const base = idx * 3;
      values.push(id, scope, refId);
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    });

    if (!placeholders.length) {
      return sendError(res, 400, 'No hay exclusiones válidas para agregar');
    }

    // Insertar (ignorar duplicados)
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

/**
 * DELETE /api/insumos/groups/:id/exclusions
 * Quitar exclusiones (volver a agregar al TODO)
 * Body: { ids: [123, 456, ...], scope: 'insumo' }
 */
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
    // Verificar que el grupo existe
    const { rowCount: groupCount } = await pool.query(
      'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2',
      [id, bizId]
    );
    if (!groupCount) return sendError(res, 404, 'not_found');

    // Preparar placeholders para WHERE IN
    const refIds = ids.map(Number).filter(Number.isFinite);
    if (!refIds.length) {
      return sendError(res, 400, 'No hay IDs válidos para eliminar');
    }

    const placeholders = refIds.map((_, idx) => `$${idx + 3}`).join(', ');
    
    // Eliminar exclusiones
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

module.exports = {
  list,         
  getOne,        
  create,        
  update,       
  replaceItems,  
  addItem,       
  removeItem,    
  remove,    
  getExclusions,
  addExclusions,
  removeExclusions,   
};
