// controllers/agrupacionesController.js
const pool = require('../config/db');

// ========================= Helpers =========================
const isArray = (v) => Array.isArray(v);
const toItemsArray = (arr) =>
  (isArray(arr) ? arr : [])
    .map(a => ({
      id: Number(a?.id ?? a?.articuloId ?? a?.codigo ?? a?.codigoArticulo),
      nombre: String(a?.nombre ?? ''),
      categoria: String(a?.categoria ?? 'Sin categoría'),
      subrubro: String(a?.subrubro ?? 'Sin subrubro'),
      precio: Number(a?.precio ?? 0)
    }))
    .filter(x => Number.isFinite(x.id) && x.id > 0);

// merge por id, preservando el orden del base
function mergeById(base = [], incoming = []) {
  const out = [...base];
  const seen = new Set(base.map(x => x.id));
  for (const it of incoming) {
    if (!seen.has(it.id)) {
      out.push(it);
      seen.add(it.id);
    }
  }
  return out;
}

// ========================= CRUD Agrupaciones =========================

// GET /agrupaciones
exports.obtenerAgrupaciones = async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, 
      COALESCE(NULLIF(articulos::text, '')::jsonb, '[]'::jsonb) AS articulos FROM agrupaciones
        ORDER BY id ASC`
    );
    return res.json(rows);
  } catch (e) {
    console.error('obtenerAgrupaciones error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
};

// POST /agrupaciones
exports.crearAgrupacion = async (req, res) => {
  try {
    const nombre = String(req.body?.nombre ?? '').trim();
    const articulos = toItemsArray(req.body?.articulos);
    if (!nombre) return res.status(400).json({ ok:false, error:'El nombre es obligatorio' });

    const { rows } = await pool.query(
      `INSERT INTO agrupaciones (nombre, articulos)
       VALUES ($1, $2::jsonb)
       RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`,
      [nombre, JSON.stringify(articulos)]
    );
    return res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ ok:false, error:'Ya existe una agrupación con ese nombre' });
    }
    console.error('crearAgrupacion error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
};

// PUT /agrupaciones/:id
// Permite cambiar nombre y/o reemplazar todo el array de artículos
exports.actualizarAgrupacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id inválido' });

    const sets = [];
    const vals = [];
    const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    if (req.body?.nombre !== undefined) {
      const nombre = String(req.body.nombre ?? '').trim();
      if (!nombre) return res.status(400).json({ ok: false, error: 'El nombre no puede quedar vacío' });
      push('nombre', nombre);
    }

    if (req.body?.articulos !== undefined) {
      const articulos = toItemsArray(req.body.articulos);
      push('articulos', JSON.stringify(articulos));
    }

    if (!sets.length) return res.json({ ok: true, data: null });

    const sql = `
      UPDATE agrupaciones
         SET ${sets.join(', ')}
       WHERE id = $${vals.length + 1}
       RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`;
    const { rows } = await pool.query(sql, [...vals, id]);

    if (!rows.length) return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });
    return res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ya existe una agrupación con ese nombre' });
    }
    console.error('actualizarAgrupacion error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// DELETE /agrupaciones/:id
exports.eliminarAgrupacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id inválido' });

    const r = await pool.query(`DELETE FROM agrupaciones WHERE id=$1`, [id]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });

    // limpiar exclusiones si existen (tabla puede no existir en algunos entornos)
    try {
      await pool.query(`DELETE FROM agrupacion_exclusiones WHERE agrupacion_id=$1`, [id]);
    } catch (_e) { /* noop */ }

    return res.json({ ok: true });
  } catch (e) {
    console.error('eliminarAgrupacion error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// PUT /agrupaciones/:id/articulos
// Agrega en “append” artículos nuevos SIN duplicar por id
exports.agregarArticulosAgrupacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id inválido' });

    const incoming = toItemsArray(req.body?.articulos);
    if (!incoming.length) return res.status(400).json({ ok: false, error: 'Sin artículos para agregar' });

    const { rows: r0 } = await pool.query(`SELECT COALESCE(NULLIF(articulos::text,'')::jsonb,'[]'::jsonb) AS articulos FROM agrupaciones WHERE id=$1`, [id]);
    if (!r0.length) return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });

    const base = isArray(r0[0].articulos) ? r0[0].articulos : [];
    const merged = mergeById(base, incoming);

    const { rows } = await pool.query(
      `UPDATE agrupaciones
          SET articulos = $1::jsonb
        WHERE id = $2
        RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`,
      [JSON.stringify(merged), id]
    );

    return res.json(rows[0]);
  } catch (e) {
    console.error('agregarArticulosAgrupacion error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// DELETE /agrupaciones/:id/articulos/:articuloId
exports.eliminarArticuloDeAgrupacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const articuloId = Number(req.params.articuloId);
    if (!Number.isFinite(id) || !Number.isFinite(articuloId)) {
      return res.status(400).json({ ok: false, error: 'id/articuloId inválidos' });
    }

    const { rows: r0 } = await pool.query(`SELECT COALESCE(NULLIF(articulos::text,'')::jsonb,'[]'::jsonb) AS articulos FROM agrupaciones WHERE id=$1`, [id]);
    if (!r0.length) return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });

    const base = isArray(r0[0].articulos) ? r0[0].articulos : [];
    const filtered = base.filter(a => Number(a.id) !== articuloId);

    const { rows } = await pool.query(
      `UPDATE agrupaciones
          SET articulos = $1::jsonb
        WHERE id = $2
        RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`,
      [JSON.stringify(filtered), id]
    );

    return res.json(rows[0]);
  } catch (e) {
    console.error('eliminarArticuloDeAgrupacion error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ========================= “TODO” + Exclusiones =========================

exports.ensureTodoAgrupacion = async (_req, res) => {
  try {
    const q1 = await pool.query(`SELECT id, nombre FROM agrupaciones WHERE nombre='TODO' LIMIT 1`);
    if (q1.rows.length) return res.json(q1.rows[0]);

    const q2 = await pool.query(
      `INSERT INTO agrupaciones (nombre)
       VALUES ('TODO', '[]'::jsonb)
       ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre
       RETURNING id, nombre`
    );
    return res.status(201).json(q2.rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      const q = await pool.query(`SELECT id, nombre FROM agrupaciones WHERE nombre='TODO' LIMIT 1`);
      if (q.rows.length) return res.json(q.rows[0]);
    }
    console.error('ensureTodoAgrupacion error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
};

// GET /agrupaciones/:id/exclusiones
exports.listarExclusiones = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id inválido' });

    // si la tabla no existe aún, respondemos [] en vez de 500
    try {
      const { rows } = await pool.query(
        `SELECT scope, ref_id
           FROM agrupacion_exclusiones
          WHERE agrupacion_id = $1
          ORDER BY scope, ref_id`,
        [id]
      );
      return res.json(rows);
    } catch (e) {
      // Tabla ausente: 42P01 undefined_table
      if (e.code === '42P01') return res.json([]);
      throw e;
    }
  } catch (e) {
    console.error('listarExclusiones error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /agrupaciones/:id/exclusiones
// body: { mode:'add'|'remove', items: [{ scope:'categoria'|'subrubro'|'articulo', ref_id:string|number }] }
exports.upsertExclusiones = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id inválido' });

    const mode = String(req.body?.mode || '').toLowerCase();
    const items = isArray(req.body?.items) ? req.body.items : [];
    if (!['add', 'remove'].includes(mode)) {
      return res.status(400).json({ ok: false, error: 'mode debe ser "add" o "remove"' });
    }
    if (!items.length) {
      return res.status(400).json({ ok: false, error: 'items vacío' });
    }

    const allowed = new Set(['categoria', 'subrubro', 'articulo']);
    const norm = items.map(x => ({
      scope: String(x.scope || '').toLowerCase(),
      ref_id: String(x.ref_id ?? '').trim()
    })).filter(x => allowed.has(x.scope) && x.ref_id !== '');

    if (!norm.length) return res.status(400).json({ ok: false, error: 'items inválidos' });

    // Si la tabla no existe aún, la creamos on-the-fly para no romper producción
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agrupacion_exclusiones (
        id SERIAL PRIMARY KEY,
        agrupacion_id INT NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK (scope IN ('categoria','subrubro','articulo')),
        ref_id TEXT NOT NULL,
        UNIQUE (agrupacion_id, scope, ref_id)
      );
    `);

    if (mode === 'add') {
      let added = 0;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const it of norm) {
          const r = await client.query(
            `INSERT INTO agrupacion_exclusiones (agrupacion_id, scope, ref_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (agrupacion_id, scope, ref_id) DO NOTHING`,
            [id, it.scope, it.ref_id]
          );
          added += r.rowCount || 0;
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return res.json({ ok: true, added, removed: 0, total: added });
    } else {
      const params = [];
      const conds = [];
      let i = 1;
      for (const it of norm) {
        params.push(id, it.scope, it.ref_id);
        conds.push(`(agrupacion_id = $${i++} AND scope = $${i++} AND ref_id = $${i++})`);
      }
      const sql = `DELETE FROM agrupacion_exclusiones WHERE ${conds.join(' OR ')}`;
      const r = await pool.query(sql, params);
      return res.json({ ok: true, added: 0, removed: r.rowCount || 0, total: r.rowCount || 0 });
    }
  } catch (e) {
    console.error('upsertExclusiones error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
