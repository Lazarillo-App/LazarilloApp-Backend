// controllers/agrupacionesInsumosController.js
const pool = require('../config/db');

/**
 * Normaliza arrays de IDs desde:
 *  - { insumoIds: [1,2,3] }
 *  - { insumos: [1,2,3] }  // o [{id:1}, {id:2}]
 */
function normalizeIds(body) {
  const toNum = (v) => {
    const n = Number(v?.id ?? v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const base =
    Array.isArray(body?.insumoIds) ? body.insumoIds :
    Array.isArray(body?.insumos)   ? body.insumos   : [];
  const set = new Set();
  for (const raw of base) {
    const n = toNum(raw);
    if (n) set.add(n);
  }
  return Array.from(set.values());
}

exports.crear = async (req, res) => {
  const nombre = String(req.body?.nombre ?? '').trim();
  const descripcion = req.body?.descripcion ?? null;
  const orden = Number.isFinite(Number(req.body?.orden)) ? Number(req.body.orden) : 0;
  const ids = normalizeIds(req.body);

  if (!nombre) {
    return res.status(400).json({ ok: false, error: 'Nombre requerido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO insumo_grupos (nombre, descripcion, orden, activo)
       VALUES ($1,$2,$3, TRUE)
       RETURNING id, nombre, descripcion, orden, activo`,
      [nombre, descripcion, orden]
    );
    const grupo = rows[0];

    let added = 0;
    if (ids.length) {
      const values = [];
      const params = [];
      ids.forEach((id, i) => {
        params.push(grupo.id, id, i);
        values.push(`($${params.length - 2}, $${params.length - 1}, $${params.length})`);
      });
      const r = await client.query(
        `INSERT INTO insumo_grupo_items (grupo_id, insumo_id, orden)
         VALUES ${values.join(', ')}
         ON CONFLICT (grupo_id, insumo_id) DO NOTHING`,
        params
      );
      added = r.rowCount || 0;
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, data: grupo, added });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('crear grupo error:', e);
    res.status(500).json({ ok: false, error: 'internal' });
  } finally {
    client.release();
  }
};

exports.eliminar = async (req, res) => {
  try {
    const id = Number(req.params?.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id inválido' });

    const r = await pool.query(
      `UPDATE insumo_grupos SET activo=FALSE, updated_at=NOW() WHERE id=$1`,
      [id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: 'Grupo no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    console.error('eliminar grupo error:', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
};

// ===== Items =====
exports.agregarItems = async (req, res) => {
  const id = Number(req.params?.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id inválido' });

  const ids = normalizeIds(req.body);
  if (!ids.length) return res.status(400).json({ ok: false, error: 'insumoIds vacío' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const g = await client.query(`SELECT id FROM insumo_grupos WHERE id=$1 AND activo=TRUE`, [id]);
    if (!g.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Grupo no encontrado' });
    }

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
    res.json({ ok: true, added: r.rowCount || 0 });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('agregarItems error:', e);
    res.status(500).json({ ok: false, error: 'internal' });
  } finally {
    client.release();
  }
};

exports.quitarItem = async (req, res) => {
  try {
    const id = Number(req.params?.id);
    const insumoId = Number(req.params?.insumoId);
    if (!Number.isFinite(id) || !Number.isFinite(insumoId)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const r = await pool.query(
      `DELETE FROM insumo_grupo_items WHERE grupo_id=$1 AND insumo_id=$2`,
      [id, insumoId]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: 'Item no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    console.error('quitarItem error:', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
};

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
    res.json(rows || []);
  } catch (e) {
    console.error('listar grupos error:', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
};
