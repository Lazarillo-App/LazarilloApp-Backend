const pool = require('../config/db');

async function listGroups({ businessId, tipo }) {
  const { rows } = await pool.query(
    `
    SELECT id, nombre, tipo
    FROM agrupaciones
    WHERE business_id = $1 AND tipo = $2
    ORDER BY nombre ASC
    `,
    [businessId, tipo]
  );
  return rows;
}

async function getGroupWithInsumos({ businessId, groupId }) {
  const { rows } = await pool.query(
    `
    SELECT
      g.id,
      g.nombre,
      json_agg(
        json_build_object(
          'id', i.id,
          'nombre', i.nombre,
          'estado', i.estado
        )
        ORDER BY i.nombre
      ) AS insumos
    FROM agrupaciones g
    LEFT JOIN agrupacion_insumos gi ON gi.agrupacion_id = g.id
    LEFT JOIN insumos i ON i.id = gi.insumo_id
    WHERE g.business_id = $1 AND g.id = $2
    GROUP BY g.id
    `,
    [businessId, groupId]
  );

  return rows[0] || null;
}

async function replaceGroupInsumos({ groupId, insumoIds }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `DELETE FROM agrupacion_insumos WHERE agrupacion_id = $1`,
      [groupId]
    );

    for (const id of insumoIds) {
      await client.query(
        `
        INSERT INTO agrupacion_insumos (agrupacion_id, insumo_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        `,
        [groupId, id]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  listGroups,
  getGroupWithInsumos,
  replaceGroupInsumos,
};