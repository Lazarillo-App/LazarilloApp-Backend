// repos/insumoGroupsRepo.js
/* eslint-disable no-console */
const pool = require('../config/db');

/**
 * Devuelve todas las agrupaciones de insumos de un negocio.
 * Opcionalmente con sus insumos asociados.
 */
async function listForBusiness(businessId, { withItems = true } = {}) {
  const { rows: groups } = await pool.query(
    `
    SELECT id, business_id, nombre, descripcion, es_favorita, created_at, updated_at
    FROM insumo_groups
    WHERE business_id = $1
    ORDER BY nombre ASC
    `,
    [businessId]
  );

  if (!withItems || !groups.length) return groups;

  const groupIds = groups.map((g) => g.id);

  const { rows: items } = await pool.query(
    `
    SELECT
      gi.group_id,
      gi.insumo_id,
      i.nombre,
      i.unidad_med,
      i.precio_ref,
      i.rubro,
      i.activo
    FROM insumo_group_items gi
    JOIN insumos i ON i.id = gi.insumo_id
    WHERE gi.group_id = ANY($1::int[])
    ORDER BY i.nombre ASC
    `,
    [groupIds]
  );

  const byGroup = new Map();
  for (const g of groups) byGroup.set(g.id, []);
  for (const it of items) {
    const arr = byGroup.get(it.group_id);
    if (arr) {
      arr.push({
        insumo_id: it.insumo_id,
        nombre: it.nombre,
        unidad_med: it.unidad_med,
        precio_ref: it.precio_ref,
        rubro: it.rubro,
        activo: it.activo,
      });
    }
  }

  return groups.map((g) => ({
    ...g,
    insumos: byGroup.get(g.id) || [],
  }));
}

/**
 * Trae una agrupación puntual (con insumos).
 */
async function getOne(businessId, groupId) {
  const { rows } = await pool.query(
    `
    SELECT id, business_id, nombre, descripcion, es_favorita, created_at, updated_at
    FROM insumo_groups
    WHERE business_id = $1 AND id = $2
    `,
    [businessId, groupId]
  );
  if (!rows.length) return null;
  const group = rows[0];

  const { rows: items } = await pool.query(
    `
    SELECT
      gi.insumo_id,
      i.nombre,
      i.unidad_med,
      i.precio_ref,
      i.rubro,
      i.activo
    FROM insumo_group_items gi
    JOIN insumos i ON i.id = gi.insumo_id
    WHERE gi.group_id = $1
    ORDER BY i.nombre ASC
    `,
    [groupId]
  );

  return {
    ...group,
    insumos: items.map((it) => ({
      insumo_id: it.insumo_id,
      nombre: it.nombre,
      unidad_med: it.unidad_med,
      precio_ref: it.precio_ref,
      rubro: it.rubro,
      activo: it.activo,
    })),
  };
}

/**
 * Crea una agrupación de insumos (+ items opcionales).
 */
async function createGroup({ businessId, nombre, descripcion, esFavorita = false, insumoIds = [] }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // si marcamos favorita, desmarcamos otras del negocio
    if (esFavorita) {
      await client.query(
        `UPDATE insumo_groups
         SET es_favorita = FALSE
         WHERE business_id = $1`,
        [businessId]
      );
    }

    const { rows } = await client.query(
      `
      INSERT INTO insumo_groups (business_id, nombre, descripcion, es_favorita)
      VALUES ($1, $2, $3, $4)
      RETURNING id, business_id, nombre, descripcion, es_favorita, created_at, updated_at
      `,
      [businessId, nombre, descripcion || null, !!esFavorita]
    );

    const group = rows[0];

    if (Array.isArray(insumoIds) && insumoIds.length > 0) {
      for (const rawId of insumoIds) {
        const insumoId = Number(rawId);
        if (!Number.isFinite(insumoId)) continue;
        await client.query(
          `
          INSERT INTO insumo_group_items (group_id, insumo_id)
          VALUES ($1, $2)
          ON CONFLICT (group_id, insumo_id) DO NOTHING
          `,
          [group.id, insumoId]
        );
      }
    }

    await client.query('COMMIT');

    // devolvemos con items
    return getOne(businessId, group.id);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('createGroup error:', e);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Actualiza nombre / descripción / es_favorita.
 */
async function updateGroup({ businessId, groupId, nombre, descripcion, esFavorita }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (esFavorita === true) {
      await client.query(
        `UPDATE insumo_groups
         SET es_favorita = FALSE
         WHERE business_id = $1 AND id <> $2`,
        [businessId, groupId]
      );
    }

    const sets = [];
    const vals = [];
    const push = (col, val) => {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    };

    if (nombre !== undefined) push('nombre', nombre);
    if (descripcion !== undefined) push('descripcion', descripcion);
    if (esFavorita !== undefined) push('es_favorita', !!esFavorita);

    if (sets.length) {
      vals.push(businessId);
      vals.push(groupId);
      const sql = `
        UPDATE insumo_groups
        SET ${sets.join(', ')}, updated_at = NOW()
        WHERE business_id = $${vals.length - 1} AND id = $${vals.length}
      `;
      await client.query(sql, vals);
    }

    await client.query('COMMIT');
    return getOne(businessId, groupId);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('updateGroup error:', e);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Reemplaza los items de una agrupación por el array dado de insumoIds.
 */
async function replaceGroupItems({ businessId, groupId, insumoIds = [] }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // chequeo simple: que el group pertenezca al negocio
    const { rows } = await client.query(
      `SELECT id FROM insumo_groups WHERE id = $1 AND business_id = $2`,
      [groupId, businessId]
    );
    if (!rows.length) {
      throw new Error('Grupo de insumos no encontrado para este negocio');
    }

    await client.query(
      `DELETE FROM insumo_group_items WHERE group_id = $1`,
      [groupId]
    );

    for (const rawId of insumoIds) {
      const insumoId = Number(rawId);
      if (!Number.isFinite(insumoId)) continue;
      await client.query(
        `
        INSERT INTO insumo_group_items (group_id, insumo_id)
        VALUES ($1, $2)
        ON CONFLICT (group_id, insumo_id) DO NOTHING
        `,
        [groupId, insumoId]
      );
    }

    await client.query('COMMIT');
    return getOne(businessId, groupId);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('replaceGroupItems error:', e);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Borra una agrupación (items caen por ON DELETE CASCADE).
 */
async function deleteGroup(businessId, groupId) {
  const { rowCount } = await pool.query(
    `DELETE FROM insumo_groups WHERE business_id = $1 AND id = $2`,
    [businessId, groupId]
  );
  return rowCount > 0;
}

module.exports = {
  listForBusiness,
  getOne,
  createGroup,
  updateGroup,
  replaceGroupItems,
  deleteGroup,
};
