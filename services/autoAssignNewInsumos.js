// services/autoAssignNewInsumos.js
const pool = require('../config/db');

const norm = (s) => String(s || '').trim();

const isSystemGroup = (nombre) => {
  const n = norm(nombre).toLowerCase();
  return n === 'todo'
    || n === 'sin agrupacion'
    || n === 'sin agrupación'
    || n === 'discontinuados'
    || n === 'descontinuados';
};

/**
 * Auto-asigna insumos sin grupo según reglas:
 * (business_id, rubro_codigo, es_elaborador) -> group_id
 *
 * Devuelve:
 * {
 *   assigned,
 *   details: [{
 *     group_id, group_nombre,
 *     intentados, agregados,
 *     rubros: string[]   // opcional, ayuda para notificación/debug
 *   }]
 * }
 */
async function autoAssignNewInsumos(businessId) {
  const bid = Number(businessId);
  if (!Number.isFinite(bid) || bid <= 0) return { assigned: 0, details: [] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Traer reglas (destinos) para este negocio
    const { rows: rulesRows } = await client.query(`
      SELECT r.rubro_codigo, r.es_elaborador, r.group_id, g.nombre AS group_nombre
      FROM insumo_group_rules r
      JOIN insumo_groups g ON g.id = r.group_id
      WHERE r.business_id = $1
    `, [bid]);

    // Filtrar reglas cuyo grupo sea “sistema”
    const rules = rulesRows
      .filter(r => !isSystemGroup(r.group_nombre))
      .map(r => ({
        rubro: norm(r.rubro_codigo),
        es_elaborador: !!r.es_elaborador,
        group_id: Number(r.group_id),
        group_nombre: r.group_nombre,
      }));

    if (!rules.length) {
      await client.query('COMMIT');
      return { assigned: 0, details: [] };
    }

    const ruleMap = new Map(); // key = `${rubro}|${es_elaborador}` -> rule
    for (const r of rules) {
      ruleMap.set(`${r.rubro}|${r.es_elaborador ? 1 : 0}`, r);
    }

    // 2) Insumos elegibles (activos y no discontinuados)
    const { rows: insRows } = await client.query(`
      SELECT
        i.id,
        COALESCE(NULLIF(TRIM(i.rubro), ''), '') AS rubro,
        COALESCE(ir.es_elaborador, false) AS es_elaborador
      FROM insumos i
      LEFT JOIN insumo_rubros ir
        ON ir.business_id = i.business_id
       AND ir.codigo::text = i.rubro::text
      WHERE i.business_id = $1
        AND i.activo = true
        AND COALESCE(i.estado,'activo') <> 'discontinuado'
    `, [bid]);

    if (!insRows.length) {
      await client.query('COMMIT');
      return { assigned: 0, details: [] };
    }

    // 3) Insumos ya asignados
    const { rows: assignedRows } = await client.query(`
      SELECT DISTINCT gi.insumo_id
      FROM insumo_group_items gi
      JOIN insumo_groups g ON g.id = gi.group_id
      WHERE g.business_id = $1
    `, [bid]);

    const assignedIds = new Set(
      assignedRows
        .map(x => Number(x.insumo_id))
        .filter(n => Number.isFinite(n) && n > 0)
    );

    // 4) Armar lote por group_id (con rubros agregados como Set)
    const byGroup = new Map();
    for (const ins of insRows) {
      const id = Number(ins.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (assignedIds.has(id)) continue;

      const rubro = norm(ins.rubro);
      if (!rubro) continue;

      const esElab = !!ins.es_elaborador;
      const rule = ruleMap.get(`${rubro}|${esElab ? 1 : 0}`);
      if (!rule) continue;

      if (!byGroup.has(rule.group_id)) {
        byGroup.set(rule.group_id, {
          group_id: rule.group_id,
          group_nombre: rule.group_nombre,
          ids: [],
          rubros: new Set(),
        });
      }

      const bucket = byGroup.get(rule.group_id);
      bucket.ids.push(id);
      bucket.rubros.add(rubro);
    }

    if (byGroup.size === 0) {
      await client.query('COMMIT');
      return { assigned: 0, details: [] };
    }

    // 5) Bulk insert idempotente
    let totalAssigned = 0;
    const details = [];

    for (const g of byGroup.values()) {
      const ids = g.ids;
      if (!ids.length) continue;

      const groupIds = new Array(ids.length).fill(Number(g.group_id));

      const r = await client.query(`
        INSERT INTO insumo_group_items (group_id, insumo_id)
        SELECT * FROM UNNEST($1::int[], $2::int[])
        ON CONFLICT (group_id, insumo_id) DO NOTHING
      `, [groupIds, ids]);

      const added = r.rowCount || 0;
      totalAssigned += added;

      details.push({
        group_id: g.group_id,
        group_nombre: g.group_nombre,
        intentados: ids.length,
        agregados: added,
        rubros: Array.from(g.rubros).slice(0, 30),
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
