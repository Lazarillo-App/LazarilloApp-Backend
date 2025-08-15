// controllers/agrupacionesController.js
const pool = require('../config/db');

// ========================= Helpers =========================
const isArray = (v) => Array.isArray(v);
const nowISO = () => new Date().toISOString();
const toItemsArray = (arr) =>
  (isArray(arr) ? arr : []).map(a => ({
    id: Number(a.id),
    nombre: String(a.nombre ?? ''),
    categoria: String(a.categoria ?? 'Sin categoría'),
    subrubro: String(a.subrubro ?? 'Sin subrubro'),
    precio: Number(a.precio ?? 0)
  })).filter(x => Number.isFinite(x.id) && x.id > 0);

// merge por id, preservando el primero (mantiene orden)
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
// POST /agrupaciones
exports.crearAgrupacion = async (req, res) => {
  try {
    const nombre = (req.body?.nombre ?? '').trim();
    const articulos = toItemsArray(req.body?.articulos);

    if (!nombre) return res.status(400).json({ ok:false, error:'El nombre es obligatorio' });

    const { rows } = await pool.query(
      `INSERT INTO agrupaciones (nombre, articulos, created_at, updated_at)
       VALUES ($1, $2::jsonb, NOW(), NOW())
       RETURNING *`,
      [nombre, JSON.stringify(articulos)]
    );

    return res.status(201).json(rows[0]);
  } catch (e) {
    // Si existe unique(nombre), capturamos violación:
    if (e.code === '23505') {
      return res.status(409).json({ ok:false, error:'Ya existe una agrupación con ese nombre' });
    }
    console.error('crearAgrupacion error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
};

// GET /agrupaciones
exports.obtenerAgrupaciones = async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, articulos, created_at, updated_at
       FROM agrupaciones
       ORDER BY created_at DESC`
    );
    return res.json(rows);
  } catch (e) {
    console.error('obtenerAgrupaciones error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
};

// PUT /agrupaciones/:id
// Permite cambiar nombre y/o reemplazar todo el array de artículos
exports.actualizarAgrupacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok:false, error:'id inválido' });

    const sets = [];
    const vals = [];
    const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    if (req.body?.nombre !== undefined) {
      const nombre = String(req.body.nombre ?? '').trim();
      if (!nombre) return res.status(400).json({ ok:false, error:'El nombre no puede quedar vacío' });
      push('nombre', nombre);
    }

    if (req.body?.articulos !== undefined) {
      const articulos = toItemsArray(req.body.articulos);
      push('articulos', JSON.stringify(articulos));
    }

    if (!sets.length) return res.json({ ok:true, data: null });

    push('updated_at', nowISO());

    const { rows } = await pool.query(
      `UPDATE agrupaciones
         SET ${sets.join(', ')}
       WHERE id = $${vals.length - 1}
       RETURNING *`,
      vals
    );

    if (!rows.length) return res.status(404).json({ ok:false, error:'Agrupación no encontrada' });
    return res.json(rows[0]);
  } catch (e) {
    // manejar duplicado de nombre
    if (e.code === '23505') {
      return res.status(409).json({ ok:false, error:'Ya existe una agrupación con ese nombre' });
    }
    console.error('actualizarAgrupacion error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
};

// DELETE /agrupaciones/:id
exports.eliminarAgrupacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok:false, error:'id inválido' });

    const r = await pool.query(`DELETE FROM agrupaciones WHERE id=$1`, [id]);
    if (!r.rowCount) return res.status(404).json({ ok:false, error:'Agrupación no encontrada' });

    // limpiar exclusiones si existen
    await pool.query(`DELETE FROM agrupacion_exclusiones WHERE agrupacion_id=$1`, [id]);

    return res.json({ ok:true });
  } catch (e) {
    console.error('eliminarAgrupacion error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
};

// PUT /agrupaciones/:id/articulos
// Agrega en “append” artículos nuevos SIN duplicar por id
exports.agregarArticulosAgrupacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok:false, error:'id inválido' });

    const incoming = toItemsArray(req.body?.articulos);
    if (!incoming.length) return res.status(400).json({ ok:false, error:'Sin artículos para agregar' });

    const { rows: r0 } = await pool.query(`SELECT articulos FROM agrupaciones WHERE id=$1`, [id]);
    if (!r0.length) return res.status(404).json({ ok:false, error:'Agrupación no encontrada' });

    const base = isArray(r0[0].articulos) ? r0[0].articulos : [];
    const merged = mergeById(base, incoming);

    const { rows } = await pool.query(
      `UPDATE agrupaciones
         SET articulos = $1::jsonb,
             updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(merged), id]
    );

    return res.json(rows[0]);
  } catch (e) {
    console.error('agregarArticulosAgrupacion error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
};

// DELETE /agrupaciones/:id/articulos/:articuloId
exports.eliminarArticuloDeAgrupacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const articuloId = Number(req.params.articuloId);
    if (!Number.isFinite(id) || !Number.isFinite(articuloId)) {
      return res.status(400).json({ ok:false, error:'id/articuloId inválidos' });
    }

    const { rows: r0 } = await pool.query(`SELECT articulos FROM agrupaciones WHERE id=$1`, [id]);
    if (!r0.length) return res.status(404).json({ ok:false, error:'Agrupación no encontrada' });

    const base = isArray(r0[0].articulos) ? r0[0].articulos : [];
    const filtered = base.filter(a => Number(a.id) !== articuloId);

    const { rows } = await pool.query(
      `UPDATE agrupaciones
         SET articulos = $1::jsonb,
             updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(filtered), id]
    );

    return res.json(rows[0]);
  } catch (e) {
    console.error('eliminarArticuloDeAgrupacion error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
};

// ========================= “TODO” + Exclusiones =========================
// PUT /agrupaciones/todo
// Asegura y retorna la agrupación { id, nombre:'TODO' }
exports.ensureTodoAgrupacion = async (_req, res) => {
  try {
    // 1) Buscar
    const q1 = await pool.query(
      `SELECT id, nombre FROM agrupaciones WHERE nombre = 'TODO' LIMIT 1`
    );
    if (q1.rows.length) return res.json(q1.rows[0]);

    // 2) Crear si no existe (vacía)
    const q2 = await pool.query(
      `INSERT INTO agrupaciones (nombre, articulos, created_at, updated_at)
       VALUES ('TODO', '[]'::jsonb, NOW(), NOW())
       RETURNING id, nombre`
    );
    return res.status(201).json(q2.rows[0]);
  } catch (e) {
    // en caso de condición de carrera (dos crean al mismo tiempo): 23505
    if (e.code === '23505') {
      const q = await pool.query(
        `SELECT id, nombre FROM agrupaciones WHERE nombre = 'TODO' LIMIT 1`
      );
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
    if (!Number.isFinite(id)) return res.status(400).json({ ok:false, error:'id inválido' });

    const { rows } = await pool.query(
      `SELECT scope, ref_id
       FROM agrupacion_exclusiones
       WHERE agrupacion_id = $1
       ORDER BY scope, ref_id`,
      [id]
    );
    return res.json(rows);
  } catch (e) {
    console.error('listarExclusiones error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
};

// POST /agrupaciones/:id/exclusiones
// body: { mode:'add'|'remove', items: [{ scope:'categoria'|'subrubro'|'articulo', ref_id:string|number }] }
exports.upsertExclusiones = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok:false, error:'id inválido' });

    const mode = String(req.body?.mode || '').toLowerCase();
    const items = isArray(req.body?.items) ? req.body.items : [];
    if (!['add', 'remove'].includes(mode)) {
      return res.status(400).json({ ok:false, error:'mode debe ser "add" o "remove"' });
    }
    if (!items.length) {
      return res.status(400).json({ ok:false, error:'items vacío' });
    }

    // Validar/normalizar
    const allowed = new Set(['categoria', 'subrubro', 'articulo']);
    const norm = items.map(x => ({
      scope: String(x.scope || '').toLowerCase(),
      ref_id: String(x.ref_id ?? '').trim()
    })).filter(x => allowed.has(x.scope) && x.ref_id !== '');

    if (!norm.length) return res.status(400).json({ ok:false, error:'items inválidos' });

    if (mode === 'add') {
      // Inserción ignorando duplicados por UNIQUE(agrupacion_id, scope, ref_id)
      let added = 0;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const it of norm) {
          try {
            const r = await client.query(
              `INSERT INTO agrupacion_exclusiones (agrupacion_id, scope, ref_id)
               VALUES ($1, $2, $3)
               ON CONFLICT (agrupacion_id, scope, ref_id) DO NOTHING`,
              [id, it.scope, it.ref_id]
            );
            added += r.rowCount || 0;
          } catch (e) {
            // omite errores de duplicado por seguridad
            if (!['23505', '42710'].includes(e.code)) throw e;
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return res.json({ ok:true, added, removed:0, total: added });
    } else {
      // remove
      const params = [];
      const conds = [];
      let i = 1;
      for (const it of norm) {
        params.push(id, it.scope, it.ref_id);
        conds.push(`(agrupacion_id = $${i++} AND scope = $${i++} AND ref_id = $${i++})`);
      }
      const sql = `DELETE FROM agrupacion_exclusiones WHERE ${conds.join(' OR ')}`;
      const r = await pool.query(sql, params);
      return res.json({ ok:true, added:0, removed:r.rowCount || 0, total: r.rowCount || 0 });
    }
  } catch (e) {
    console.error('upsertExclusiones error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
};
