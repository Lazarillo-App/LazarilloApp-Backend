// controllers/agrupacionesInsumosController.js
const pool = require('../config/db');

/**
 * Normaliza arrays de IDs desde:
 *  - { insumoIds: [1,2,3] }
 *  - { insumos: [1,2,3] }  // o [{id:1}, {id:2}]
 */
function normalizeIds(body) {
  if (Array.isArray(body?.insumoIds)) return body.insumoIds.map(Number).filter(Boolean);
  if (Array.isArray(body?.insumos)) {
    return body.insumos.map(x => Number(x?.id ?? x)).filter(Boolean);
  }
  return [];
}

// ===== Grupos =====
exports.listar = async (_req, res) => {
  try {
    const sql = `
      SELECT g.id, g.nombre, g.descripcion, g.orden, g.activo,
             COALESCE(cnt.cnt, 0)::int AS items
      FROM insumo_grupos g
      LEFT JOIN (
        SELECT grupo_id, COUNT(*) AS cnt
        FROM insumo_grupo_items
        GROUP BY grupo_id
      ) cnt ON cnt.grupo_id = g.id
      WHERE g.activo = TRUE
      ORDER BY g.orden, g.nombre;
    `;
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (e) {
    console.error('listar grupos error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.crear = async (req, res) => {
  const { nombre, descripcion = null, orden = 0 } = req.body || {};
  const ids = normalizeIds(req.body);
  if (!nombre || !String(nombre).trim()) {
    return res.status(400).json({ ok: false, error: 'Nombre requerido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO insumo_grupos (nombre, descripcion, orden, activo)
       VALUES ($1,$2,$3, TRUE)
       RETURNING id, nombre, descripcion, orden, activo`,
      [String(nombre).trim(), descripcion, Number(orden) || 0]
    );
    const grupo = rows[0];

    if (ids.length) {
      const values = [];
      const params = [];
      ids.forEach((id, i) => {
        params.push(grupo.id, id, i);
        values.push(`($${params.length - 2}, $${params.length - 1}, $${params.length})`);
      });
      await client.query(
        `INSERT INTO insumo_grupo_items (grupo_id, insumo_id, orden)
         VALUES ${values.join(', ')}
         ON CONFLICT (grupo_id, insumo_id) DO NOTHING`,
        params
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, data: grupo, added: ids.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('crear grupo error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

exports.eliminar = async (req, res) => {
  try {
    const { id } = req.params;
    const r = await pool.query(
      `UPDATE insumo_grupos SET activo=FALSE, updated_at=NOW() WHERE id=$1`,
      [id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: 'Grupo no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    console.error('eliminar grupo error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};

// ===== Items =====
exports.agregarItems = async (req, res) => {
  const { id } = req.params;
  const ids = normalizeIds(req.body);
  if (!ids.length) return res.status(400).json({ ok: false, error: 'insumoIds vacío' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validar que exista el grupo
    const g = await client.query(`SELECT id FROM insumo_grupos WHERE id=$1 AND activo=TRUE`, [id]);
    if (!g.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Grupo no encontrado' });
    }

    // Insert masivo con ON CONFLICT
    const values = [];
    const params = [];
    ids.forEach((insumoId, i) => {
      params.push(id, insumoId, i);
      values.push(`($${params.length - 2}, $${params.length - 1}, $${params.length})`);
    });
    const r = await client.query(
      `INSERT INTO insumo_grupo_items (grupo_id, insumo_id, orden)
       VALUES ${values.join(', ')}
       ON CONFLICT (grupo_id, insumo_id) DO NOTHING`,
      params
    );

    await client.query('COMMIT');
    res.json({ ok: true, added: r.rowCount });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('agregarItems error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

exports.quitarItem = async (req, res) => {
  try {
    const { id, insumoId } = req.params;
    const r = await pool.query(
      `DELETE FROM insumo_grupo_items WHERE grupo_id=$1 AND insumo_id=$2`,
      [id, insumoId]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: 'Item no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    console.error('quitarItem error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};
