const pool = require('../config/db');

// --- helpers existentes (isArray, toItemsArray, parseJsonArrayLoose, mergeById) se mantienen ---

const isArray = (v) => Array.isArray(v);

const toItemsArray = (arr) =>
  (Array.isArray(arr) ? arr : [])
    .map(a => ({
      id: Number(a?.id ?? a?.articuloId ?? a?.codigo ?? a?.codigoArticulo),
      nombre: String(a?.nombre ?? ''),
      categoria: String(a?.categoria ?? 'Sin categoría'),
      subrubro: String(a?.subrubro ?? 'Sin subrubro'),
      precio: Number(a?.precio ?? 0),
    }))
    .filter(x => Number.isFinite(x.id) && x.id > 0);

function parseJsonArrayLoose(val) {
  if (Array.isArray(val)) return val;
  if (val == null) return [];
  try {
    if (typeof val === 'string') {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    }
    return Array.isArray(val) ? val : [];
  } catch { return []; }
} 

function getBizId(req) {
  const header = Number(req.header('X-Business-Id'));
  const param = Number(req.params?.businessId);
  const ctx = Number(req.businessId);
  return [ctx, param, header].find(Number.isFinite);
}

const getBiz = (req) => {
  // prioridad: param, luego resuelto por middleware, luego header
  const p = Number(req.params?.businessId);
  if (Number.isFinite(p)) return p;
  if (Number.isFinite(req.businessId)) return Number(req.businessId);
  const h = Number(req.header('X-Business-Id'));
  if (Number.isFinite(h)) return h;
  return NaN;
};

// ========================= CRUD Agrupaciones =========================

// GET /businesses/:businessId/agrupaciones  (o con header X-Business-Id)
exports.obtenerAgrupaciones = async (req, res) => {
  try {
    const bizId = getBizId(req);
    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'business_id requerido' });
    }
    const { rows } = await pool.query(
      `SELECT id, nombre,
              COALESCE(NULLIF(articulos::text, '')::jsonb, '[]'::jsonb) AS articulos
         FROM agrupaciones
        WHERE business_id = $1
        ORDER BY id ASC`,
      [bizId]
    );
    res.json(rows);
  } catch (e) {
    console.error('obtenerAgrupaciones error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /businesses/:businessId/agrupaciones
exports.crearAgrupacion = async (req, res) => {
  try {
    const bizId = getBizId(req);
    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'business_id requerido' });
    }

    const nombre = String(req.body?.nombre ?? '').trim();
    const articulos = toItemsArray(req.body?.articulos);
    if (!nombre) return res.status(400).json({ ok: false, error: 'El nombre es obligatorio' });

    const { rows } = await pool.query(
      `INSERT INTO agrupaciones (business_id, nombre, articulos)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`,
      [bizId, nombre, JSON.stringify(articulos)]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ya existe una agrupación con ese nombre' });
    }
    console.error('crearAgrupacion error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

// PUT /businesses/:businessId/agrupaciones/:id
exports.actualizarAgrupacion = async (req, res) => {
  try {
    const businessId = getBiz(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

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
     AND business_id = $${vals.length + 2}
   RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`;
    const { rows } = await pool.query(sql, [...vals, id, getBizId(req)]);

    if (!rows.length) return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });
    return res.json(rows[0]);
  } catch (e) {
    console.error('actualizarAgrupacion error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// DELETE /businesses/:businessId/agrupaciones/:id
exports.eliminarAgrupacion = async (req, res) => {
  try {
    const businessId = getBiz(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const r = await pool.query(
      `DELETE FROM agrupaciones WHERE id=$1 AND business_id=$2`,
      [id, businessId]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });

    try {
      await pool.query(
        `DELETE FROM agrupacion_exclusiones WHERE agrupacion_id=$1 AND business_id=$2`,
        [id, businessId]
      );
    } catch (_) { }
    return res.json({ ok: true });
  } catch (e) {
    console.error('eliminarAgrupacion error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// PUT /businesses/:businessId/agrupaciones/:id/articulos
exports.agregarArticulosAgrupacion = async (req, res) => {
  try {
    const businessId = getBiz(req);
    const id = Number(req.params.id ?? req.params.agrupacionId);
    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const incomingArticulos = toItemsArray(req.body?.articulos);
    const incomingIds = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    const incoming = incomingArticulos.length
      ? incomingArticulos
      : incomingIds.map(x => ({ id: x, nombre: '', categoria: 'Sin categoría', subrubro: 'Sin subrubro', precio: 0 }));

    if (!incoming.length) return res.status(400).json({ ok: false, error: 'Sin artículos para agregar' });

    const { rows: r0 } = await pool.query(
      `SELECT articulos FROM agrupaciones WHERE id=$1 AND business_id=$2`,
      [id, businessId]
    );
    if (!r0.length) return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });

    const base = parseJsonArrayLoose(r0[0].articulos);
    const merged = mergeById(base, incoming);

    const { rows } = await pool.query(
      `UPDATE agrupaciones
          SET articulos = $1::jsonb
        WHERE id = $2 AND business_id = $3
        RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`,
      [JSON.stringify(merged), id, businessId]
    );

    return res.json(rows[0]);
  } catch (e) {
    console.error('agregarArticulosAgrupacion error:', { code: e.code, detail: e.detail, msg: e.message });
    return res.status(500).json({ ok: false, error: e.message, code: e.code, detail: e.detail });
  }
};

// DELETE /businesses/:businessId/agrupaciones/:id/articulos/:articuloId
exports.eliminarArticuloDeAgrupacion = async (req, res) => {
  try {
    const businessId = getBiz(req);
    const id = Number(req.params.id);
    const articuloId = Number(req.params.articuloId);
    if (!Number.isFinite(businessId) || !Number.isFinite(id) || !Number.isFinite(articuloId)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const { rows: r0 } = await pool.query(
      `SELECT articulos FROM agrupaciones WHERE id=$1 AND business_id=$2`,
      [id, businessId]
    );
    if (!r0.length) return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });

    const base = parseJsonArrayLoose(r0[0].articulos);
    const filtered = base.filter(a => Number(a.id) !== articuloId);

    const { rows } = await pool.query(
      `UPDATE agrupaciones
          SET articulos = $1::jsonb
        WHERE id = $2 AND business_id = $3
        RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`,
      [JSON.stringify(filtered), id, businessId]
    );

    return res.json(rows[0]);
  } catch (e) {
    console.error('eliminarArticuloDeAgrupacion error:', { code: e.code, detail: e.detail, msg: e.message });
    return res.status(500).json({ ok: false, error: e.message, code: e.code, detail: e.detail });
  }
};

// POST /businesses/:businessId/agrupaciones/create-or-move
// Body: { nombre: string, articulos?: [{id, precio?...}], ids?: number[] }
exports.createOrMoveAgrupacion = async (req, res) => {
  const businessId = getBiz(req);
  if (!Number.isFinite(businessId)) {
    return res.status(400).json({ ok: false, error: 'business_id requerido' });
  }

  const nombre = String(req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ ok: false, error: 'El nombre es obligatorio' });

  // Normalizamos artículos entrantes (acepta ids sueltos o objetos)
  const incomingArticulos = toItemsArray(req.body?.articulos);
  const incomingIds =
    Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  const incoming = incomingArticulos.length
    ? incomingArticulos
    : incomingIds.map(x => ({ id: x, nombre: '', categoria: 'Sin categoría', subrubro: 'Sin subrubro', precio: 0 }));

  if (!incoming.length) {
    return res.status(400).json({ ok: false, error: 'Sin artículos para procesar' });
  }

  const idsSet = new Set(incoming.map(a => Number(a.id)));
  const isTodoName = ['TODO', 'SIN AGRUPACIÓN'].includes(nombre.toUpperCase());

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) UPSERT agrupación destino por (business_id, nombre)
    const { rows: gRows } = await client.query(
      `
      INSERT INTO agrupaciones (business_id, nombre, articulos)
      VALUES ($1, $2, '[]'::jsonb)
      ON CONFLICT (business_id, nombre)
      DO UPDATE SET nombre = EXCLUDED.nombre
      RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos
      `,
      [businessId, nombre]
    );
    const destino = gRows[0];

    // 2) Si destino NO es TODO => quitar artículos de todas las otras no-TODO
    if (!isTodoName) {
      const { rows: others } = await client.query(
        `
        SELECT id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos
          FROM agrupaciones
         WHERE business_id = $1
           AND id <> $2
           AND UPPER(nombre) NOT IN ('TODO','SIN AGRUPACIÓN')
        FOR UPDATE
        `,
        [businessId, destino.id]
      );

      for (const row of others) {
        const base = parseJsonArrayLoose(row.articulos);
        const filtered = base.filter(a => !idsSet.has(Number(a.id)));
        if (filtered.length !== base.length) {
          await client.query(
            `UPDATE agrupaciones SET articulos = $1::jsonb WHERE id=$2 AND business_id=$3`,
            [JSON.stringify(filtered), row.id, businessId]
          );
        }
      }
    }
    // (si destino es TODO, no tocamos otras no-TODO: puede coexistir)

    // 3) Merge en destino (idempotente, sin duplicar dentro del grupo)
    const destBase = parseJsonArrayLoose(destino.articulos);
    const destMerged = mergeById(destBase, incoming);

    const { rows: updated } = await client.query(
      `UPDATE agrupaciones
          SET articulos = $1::jsonb
        WHERE id = $2 AND business_id = $3
        RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`,
      [JSON.stringify(destMerged), destino.id, businessId]
    );

    await client.query('COMMIT');
    return res.status(200).json({ ok: true, agrupacion: updated[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('createOrMoveAgrupacion error:', { code: e.code, detail: e.detail, msg: e.message });
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ya existe una agrupación con ese nombre' });
    }
    return res.status(500).json({ ok: false, error: e.message, code: e.code, detail: e.detail });
  } finally {
    client.release();
  }
};

// ========================= “TODO” + Exclusiones =========================

// PUT /businesses/:businessId/agrupaciones/todo
exports.ensureTodoAgrupacion = async (req, res) => {
  try {
    const businessId = getBiz(req);
    if (!Number.isFinite(businessId)) return res.status(400).json({ ok: false, error: 'businessId requerido' });

    const q1 = await pool.query(
      `SELECT id, nombre FROM agrupaciones
        WHERE business_id=$1 AND nombre='TODO'
        LIMIT 1`,
      [businessId]
    );
    if (q1.rows.length) return res.json(q1.rows[0]);

    const q2 = await pool.query(
      `INSERT INTO agrupaciones (business_id, nombre, articulos)
       VALUES ($1, 'TODO', '[]'::jsonb)
       ON CONFLICT (business_id, nombre) DO UPDATE SET nombre = EXCLUDED.nombre
       RETURNING id, nombre`,
      [businessId]
    );
    return res.status(201).json(q2.rows[0]);
  } catch (e) {
    console.error('ensureTodoAgrupacion error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// GET /businesses/:businessId/agrupaciones/:id/exclusiones
exports.listarExclusiones = async (req, res) => {
  try {
    const businessId = getBiz(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    try {
      const { rows } = await pool.query(
        `SELECT scope, ref_id
           FROM agrupacion_exclusiones
          WHERE agrupacion_id = $1 AND business_id = $2
          ORDER BY scope, ref_id`,
        [id, businessId]
      );
      return res.json(rows);
    } catch (e) {
      if (e.code === '42P01') return res.json([]);
      throw e;
    }
  } catch (e) {
    console.error('listarExclusiones error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /businesses/:businessId/agrupaciones/:id/exclusiones
exports.upsertExclusiones = async (req, res) => {
  try {
    const businessId = getBiz(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const mode = String(req.body?.mode || '').toLowerCase();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!['add', 'remove'].includes(mode) || !items.length) {
      return res.status(400).json({ ok: false, error: 'payload inválido' });
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS agrupacion_exclusiones (
        id SERIAL PRIMARY KEY,
        business_id INT NOT NULL,
        agrupacion_id INT NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK (scope IN ('categoria','subrubro','articulo')),
        ref_id TEXT NOT NULL
      );
    `);

    if (mode === 'add') {
      let added = 0;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const raw of items) {
          const scope = String(raw.scope || '').toLowerCase();
          const ref_id = String(raw.ref_id ?? '').trim();
          if (!['categoria', 'subrubro', 'articulo'].includes(scope) || !ref_id) continue;

          const r = await client.query(
            `INSERT INTO agrupacion_exclusiones (business_id, agrupacion_id, scope, ref_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [businessId, id, scope, ref_id]
          );
          added += r.rowCount || 0;
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK'); throw e;
      } finally {
        client.release();
      }
      return res.json({ ok: true, added, removed: 0, total: added });
    } else {
      const params = [];
      const conds = [];
      let i = 1;
      for (const raw of items) {
        const scope = String(raw.scope || '').toLowerCase();
        const ref_id = String(raw.ref_id ?? '').trim();
        if (!['categoria', 'subrubro', 'articulo'].includes(scope) || !ref_id) continue;
        params.push(businessId, id, scope, ref_id);
        conds.push(`(business_id=$${i++} AND agrupacion_id=$${i++} AND scope=$${i++} AND ref_id=$${i++})`);
      }
      if (!conds.length) return res.json({ ok: true, added: 0, removed: 0, total: 0 });

      const sql = `DELETE FROM agrupacion_exclusiones WHERE ${conds.join(' OR ')}`;
      const r = await pool.query(sql, params);
      return res.json({ ok: true, added: 0, removed: r.rowCount || 0, total: r.rowCount || 0 });
    }
  } catch (e) {
    console.error('upsertExclusiones error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /businesses/:businessId/agrupaciones/:fromId/move-items
exports.moveItemsBetweenGroups = async (req, res) => {
  const businessId = getBiz(req);
  const fromId = Number(req.params.id ?? req.params.fromId);
  const toId = Number(req.body?.toId);
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);

  if (!Number.isFinite(businessId) || !Number.isFinite(fromId) || !Number.isFinite(toId) || !ids.length) {
    return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
  }
  if (fromId === toId) return res.json({ ok: true, moved: 0 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, articulos FROM agrupaciones
        WHERE business_id=$1 AND id = ANY($2::int[])
        FOR UPDATE`,
      [businessId, [fromId, toId]]
    );

    const fromRow = rows.find(r => Number(r.id) === fromId);
    const toRow = rows.find(r => Number(r.id) === toId);
    if (!fromRow || !toRow) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Agrupación/es no encontrada/s' });
    }

    const fromList = parseJsonArrayLoose(fromRow.articulos);
    const toList = parseJsonArrayLoose(toRow.articulos);

    const idsSet = new Set(ids);
    const moving = fromList.filter(a => idsSet.has(Number(a.id)));
    if (!moving.length) { await client.query('COMMIT'); return res.json({ ok: true, moved: 0 }); }

    const seen = new Set(toList.map(x => Number(x.id)));
    const toMerged = [...toList];
    for (const it of moving) {
      const id = Number(it.id);
      if (!seen.has(id)) { toMerged.push({ ...it, id }); seen.add(id); }
    }
    const fromFiltered = fromList.filter(a => !idsSet.has(Number(a.id)));

    await client.query(
      `UPDATE agrupaciones SET articulos = $1::jsonb WHERE id = $2 AND business_id = $3`,
      [JSON.stringify(fromFiltered), fromId, businessId]
    );
    await client.query(
      `UPDATE agrupaciones SET articulos = $1::jsonb WHERE id = $2 AND business_id = $3`,
      [JSON.stringify(toMerged), toId, businessId]
    );

    await client.query('COMMIT');
    return res.json({ ok: true, moved: moving.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('moveItemsBetweenGroups error:', { code: e.code, detail: e.detail, msg: e.message });
    return res.status(500).json({ ok: false, error: e.message, code: e.code, detail: e.detail });
  } finally {
    client.release();
  }
};
