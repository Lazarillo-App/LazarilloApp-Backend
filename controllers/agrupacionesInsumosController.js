// controllers/agrupacionesInsumosController.js
const pool = require('../config/db');

// Normaliza lista de IDs (números únicos)
const normIds = (arr) =>
  Array.from(new Set((Array.isArray(arr) ? arr : []).map(x => Number(x)).filter(Boolean)));

exports.listar = async (_req, res) => {
  try {
    const q = `
      SELECT g.*,
             COALESCE(i.cnt,0)::int AS items_count
      FROM insumo_grupos g
      LEFT JOIN (
        SELECT grupo_id, COUNT(*)::int AS cnt
        FROM insumo_grupo_items
        GROUP BY grupo_id
      ) i ON i.grupo_id = g.id
      WHERE g.activo IS TRUE
      ORDER BY g.orden, g.nombre;
    `;
    const { rows } = await pool.query(q);
    res.json(rows);
  } catch (e) {
    console.error('listar grupos error:', e.message);
    res.status(500).json({ ok:false, error: e.message });
  }
};

exports.crear = async (req, res) => {
  const client = await pool.connect();
  try {
    const { nombre, descripcion = null, insumoIds = [] } = req.body || {};
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ ok:false, error:'Falta nombre' });
    }

    await client.query('BEGIN');
    const { rows: r1 } = await client.query(
      `INSERT INTO insumo_grupos (nombre, descripcion, activo)
       VALUES ($1,$2,TRUE) RETURNING *`,
      [String(nombre).trim(), descripcion]
    );
    const grupo = r1[0];

    const ids = normIds(insumoIds);
    if (ids.length) {
      const values = ids.map((id, i) => `($1, $${i+2}, ${i})`).join(',');
      await client.query(
        `INSERT INTO insumo_grupo_items (grupo_id, insumo_id, orden)
         VALUES ${values}
         ON CONFLICT (grupo_id, insumo_id) DO NOTHING`,
        [grupo.id, ...ids]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ok:true, data: grupo, added: ids.length });
  } catch (e) {
    await pool.query('ROLLBACK');
    console.error('crear grupo error:', e.message);
    res.status(500).json({ ok:false, error: e.message });
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
    if (!r.rowCount) return res.status(404).json({ ok:false, error:'Grupo no encontrado' });
    res.json({ ok:true });
  } catch (e) {
    console.error('eliminar grupo error:', e.message);
    res.status(500).json({ ok:false, error: e.message });
  }
};

exports.agregarItems = async (req, res) => {
  try {
    const { id } = req.params;
    const ids = normIds(req.body?.insumoIds);
    if (!ids.length) return res.status(400).json({ ok:false, error:'insumoIds vacío' });

    const values = ids.map((x,i)=>`($1,$${i+2},${i})`).join(',');
    const params = [id, ...ids];

    await pool.query(
      `INSERT INTO insumo_grupo_items (grupo_id, insumo_id, orden)
       VALUES ${values}
       ON CONFLICT (grupo_id, insumo_id) DO NOTHING`,
      params
    );
    res.json({ ok:true, added: ids.length });
  } catch (e) {
    console.error('agregarItems error:', e.message);
    res.status(500).json({ ok:false, error: e.message });
  }
};

exports.quitarItem = async (req, res) => {
  try {
    const { id, insumoId } = req.params;
    const r = await pool.query(
      `DELETE FROM insumo_grupo_items WHERE grupo_id=$1 AND insumo_id=$2`,
      [id, insumoId]
    );
    if (!r.rowCount) return res.status(404).json({ ok:false, error:'Item no encontrado' });
    res.json({ ok:true });
  } catch (e) {
    console.error('quitarItem error:', e.message);
    res.status(500).json({ ok:false, error: e.message });
  }
};
