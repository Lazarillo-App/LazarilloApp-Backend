// services/autoAssignNewInsumos.js
const pool = require('../config/db');

const norm = (s) => String(s || '').trim().toLowerCase();

const isSystemGroup = (nombre) => {
  const n = norm(nombre);
  return (
    n === 'todo' ||
    n === 'sin agrupacion' ||
    n === 'sin agrupación' ||
    n === 'sin agrupar' ||
    n === 'sin grupo' ||
    n === 'discontinuados' ||
    n === 'descontinuados'
  );
};

/**
 * Auto-asigna insumos NO asignados a grupos existentes, por rubro.
 * Regla: si existe un grupo (insumo_groups) que ya contiene al menos 1 insumo
 * con rubro X, entonces insumos nuevos con rubro X van a ese grupo.
 *
 * Idempotente: ON CONFLICT DO NOTHING requiere UNIQUE(group_id, insumo_id)
 */
async function autoAssignNewInsumos(businessId) {
  const bid = Number(businessId);
  if (!Number.isFinite(bid) || bid <= 0) return { assigned: 0, details: [] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Insumos del negocio (válidos para agrupar)
    const { rows: allInsumos } = await client.query(
      `
      SELECT i.id, COALESCE(NULLIF(TRIM(i.rubro), ''), '[PENDIENTE]') AS rubro
      FROM insumos i
      WHERE i.business_id = $1
        AND i.activo = true
        AND COALESCE(i.estado, 'activo') <> 'discontinuado'
      `,
      [bid]
    );

    if (!allInsumos.length) {
      await client.query('COMMIT');
      return { assigned: 0, details: [] };
    }

    // 2) Mapa rubro -> grupos (solo grupos reales y con al menos 1 item)
    const { rows: grouped } = await client.query(
      `
      SELECT
        g.id     AS group_id,
        g.nombre AS group_nombre,
        COALESCE(NULLIF(TRIM(i.rubro), ''), '[PENDIENTE]') AS rubro
      FROM insumo_groups g
      JOIN insumo_group_items gi ON gi.group_id = g.id
      JOIN insumos i             ON i.id = gi.insumo_id
      WHERE g.business_id = $1
      `,
      [bid]
    );

    const rubroToGroups = new Map(); // rubroNorm -> [{id,nombre}, ...]
    for (const r of grouped) {
      if (isSystemGroup(r.group_nombre)) continue;

      const key = norm(r.rubro);
      if (!key) continue;

      const gid = Number(r.group_id);
      if (!Number.isFinite(gid) || gid <= 0) continue;

      if (!rubroToGroups.has(key)) rubroToGroups.set(key, []);
      const arr = rubroToGroups.get(key);

      if (!arr.some((x) => Number(x.id) === gid)) {
        arr.push({ id: gid, nombre: r.group_nombre });
      }
    }

    if (rubroToGroups.size === 0) {
      await client.query('COMMIT');
      return { assigned: 0, details: [] };
    }

    // 3) Insumos ya asignados a algún grupo del negocio
    const { rows: assignedRows } = await client.query(
      `
      SELECT DISTINCT gi.insumo_id
      FROM insumo_group_items gi
      JOIN insumo_groups g ON g.id = gi.group_id
      WHERE g.business_id = $1
      `,
      [bid]
    );

    const assignedIds = new Set(
      assignedRows
        .map((x) => Number(x.insumo_id))
        .filter((n) => Number.isFinite(n) && n > 0)
    );

    // 4) Detectar no asignados + matchear por rubro
    const toAssign = new Map(); // groupId -> { nombre, ids: [] }

    for (const ins of allInsumos) {
      const id = Number(ins.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (assignedIds.has(id)) continue;

      const key = norm(ins.rubro);
      if (!key) continue;

      const groups = rubroToGroups.get(key);
      if (!groups || !groups.length) continue;

      const target = groups[0]; // criterio: primer match
      if (!toAssign.has(target.id)) toAssign.set(target.id, { nombre: target.nombre, ids: [] });
      toAssign.get(target.id).ids.push(id);
    }

    if (toAssign.size === 0) {
      await client.query('COMMIT');
      return { assigned: 0, details: [] };
    }

    // 5) Bulk insert en insumo_group_items
    let totalAssigned = 0;
    const details = [];

    for (const [groupId, data] of toAssign.entries()) {
      const ids = data.ids;
      if (!ids.length) continue;

      const gIds = new Array(ids.length).fill(Number(groupId));

      const res = await client.query(
        `
        INSERT INTO insumo_group_items (group_id, insumo_id)
        SELECT * FROM UNNEST($1::int[], $2::int[])
        ON CONFLICT DO NOTHING
        `,
        [gIds, ids]
      );

      const added = res.rowCount || 0;
      totalAssigned += added;

      details.push({
        group_id: Number(groupId),
        group_nombre: data.nombre,
        insumos_intentados: ids.length,
        insumos_agregados: added,
      });
    }

    await client.query('COMMIT');
    return { assigned: totalAssigned, details };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { autoAssignNewInsumos };
