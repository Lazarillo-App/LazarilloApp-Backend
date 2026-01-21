// controllers/agrupacionesController.js
const pool = require('../config/db');

/* ========================= Helpers ========================= */
const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const normalizeItem = (o = {}) => {
  const id =
    safeNum(o.id) ??
    safeNum(o.articulo_id) ??
    safeNum(o.codigo) ??
    safeNum(o.codigoArticulo);

  if (id == null) return null;

  const nombre = String(o.nombre ?? o.descripcion ?? '').trim() || `#${id}`;
  const categoria = String(o.categoria ?? o.rubro ?? 'Sin categoría').trim() || 'Sin categoría';
  const subrubro = String(o.subrubro ?? o.subRubro ?? 'Sin subrubro').trim() || 'Sin subrubro';
  const precio = Number(o.precio ?? o.precioVenta ?? o.importe ?? 0) || 0;

  return { id, nombre, categoria, subrubro, precio };
};

const parseJsonArrayLoose = (x) => {
  try {
    if (Array.isArray(x)) return x.filter(Boolean);
    if (x == null) return [];
    const j = JSON.parse(typeof x === 'string' ? x : String(x));
    return Array.isArray(j) ? j.filter(Boolean) : [];
  } catch { return []; }
};

const toItemsArray = (arr) =>
  (Array.isArray(arr) ? arr : []).map(normalizeItem).filter(Boolean);

/** Une base + incoming por id (sin duplicados). Si ya existe, actualiza campos. */
const mergeJsonById = (base = [], incoming = []) => {
  const map = new Map();
  for (const b of base) {
    const it = normalizeItem(b);
    if (it) map.set(it.id, it);
  }
  for (const inc of incoming) {
    const it = normalizeItem(inc);
    if (!it) continue;
    const prev = map.get(it.id);
    map.set(it.id, prev ? { ...prev, ...it } : it);
  }
  return Array.from(map.values());
};

/** Prioridad: middleware (req.businessId) > param (:businessId) > header (X-Business-Id) */
function getBusinessId(req) {
  const ctx = Number(req.businessId);
  if (Number.isFinite(ctx)) return ctx;
  const p = Number(req.params?.businessId);
  if (Number.isFinite(p)) return p;
  const h = Number(req.header('X-Business-Id'));
  if (Number.isFinite(h)) return h;
  return NaN;
}

/* ========================= Nombres especiales ========================= */

const TODO_NAME_INITIAL = 'Sin Agrupacion';
const TODO_NAME_LEGACY = 'Sin Agrupación';
const DISC_NAME = 'Discontinuados';

// solo nombres que significan "grupo automático de sobrantes"
const TODO_NAMES = [TODO_NAME_INITIAL, TODO_NAME_LEGACY];

const normName = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const isTodoName = (s) => {
  const n = normName(s);
  return n === 'sin agrupacion' || n === 'sin agrupación' || n === 'todo';
};

const isDiscontinuadosName = (s) => {
  const n = normName(s);
  return n === 'discontinuados' || n === 'descontinuados';
};

/* ========================= CRUD Agrupaciones ========================= */

/**
 * GET /businesses/:id/agrupaciones
 * ACTUALIZADO: Soporta filtrado por división
 * 
 * Headers opcionales:
 * - X-Division-Id: ID de la división activa (si hay)
 */
exports.obtenerAgrupaciones = async (req, res) => {
  const businessId = req.params.id;
  const divisionId = req.headers['x-division-id']; // 🆕 Division activa
  
  console.log('[obtenerAgrupaciones] 📦 Request:', {
    businessId,
    divisionId: divisionId || 'ninguna (principal)',
  });

  try {
    // 1. Determinar si es división principal o secundaria
    let isMainDivision = true;
    
    if (divisionId) {
      const divCheck = await pool.query(
        'SELECT is_main FROM business_divisions WHERE id = $1 AND business_id = $2',
        [divisionId, businessId]
      );
      
      if (divCheck.rows.length > 0) {
        isMainDivision = divCheck.rows[0].is_main;
      }
    }

    // 2. Obtener grupos filtrados según división
    let groupsQuery;
    let groupsParams;

    if (!divisionId || isMainDivision) {
      // PRINCIPAL: Excluir grupos asignados a divisiones secundarias
      groupsQuery = `
        SELECT DISTINCT bg.id, bg.name, bg.business_id, bg.created_at
        FROM business_groups bg
        WHERE bg.business_id = $1
          AND bg.id NOT IN (
            SELECT dga.group_id 
            FROM division_group_assignments dga
            JOIN business_divisions bd ON bd.id = dga.division_id
            WHERE bd.business_id = $1 
              AND bd.is_main = false
          )
        ORDER BY bg.name
      `;
      groupsParams = [businessId];
      
      console.log('[obtenerAgrupaciones] 🏠 Filtrando para PRINCIPAL (excluye asignados)');
    } else {
      // SECUNDARIA: Solo grupos asignados a esta división
      groupsQuery = `
        SELECT DISTINCT bg.id, bg.name, bg.business_id, bg.created_at
        FROM business_groups bg
        JOIN division_group_assignments dga ON dga.group_id = bg.id
        WHERE bg.business_id = $1
          AND dga.division_id = $2
        ORDER BY bg.name
      `;
      groupsParams = [businessId, divisionId];
      
      console.log('[obtenerAgrupaciones] 📁 Filtrando para división:', divisionId);
    }

    const groupsResult = await pool.query(groupsQuery, groupsParams);
    const groups = groupsResult.rows;

    console.log('[obtenerAgrupaciones] ✅ Grupos encontrados:', groups.length);

    // 3. Para cada grupo, obtener sus artículos
    const agrupaciones = [];

    for (const group of groups) {
      // Obtener artículos del grupo
      const articlesQuery = `
        SELECT 
          a.id,
          a.nombre,
          a.precio,
          a.costo,
          COALESCE(cat.categoria, 'Sin categoría') as categoria,
          COALESCE(cat.subrubro, 'Sin subrubro') as subrubro
        FROM article_groups ag
        JOIN app_articles a ON a.id = ag.article_id
        LEFT JOIN articulo_categorias cat ON cat.articulo_id = a.id
        WHERE ag.group_id = $1
          AND a.business_id = $2
        ORDER BY a.nombre
      `;

      const articlesResult = await pool.query(articlesQuery, [group.id, businessId]);

      agrupaciones.push({
        id: group.id,
        group_id: group.id,
        nombre: group.name,
        articulos: articlesResult.rows,
      });
    }

    // 4. Asegurar que existan "Sin Agrupación" y "Discontinuados"
    // Estos son independientes por división
    const specialGroups = await ensureSpecialGroups(businessId, divisionId, isMainDivision);
    
    return res.json({
      ok: true,
      agrupaciones: [...agrupaciones, ...specialGroups],
      filtered_by_division: !!divisionId,
      is_main_division: isMainDivision,
      division_id: divisionId || null,
    });

  } catch (error) {
    console.error('[obtenerAgrupaciones] ❌ Error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}

// POST /businesses/:businessId/agrupaciones
exports.crearAgrupacion = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
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
    const businessId = getBusinessId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Necesitamos saber cómo se llamaba ANTES para detectar si era el grupo automático
    let prevNombre = null;
    try {
      const { rows: prevRows } = await pool.query(
        `SELECT nombre FROM agrupaciones WHERE id = $1 AND business_id = $2`,
        [id, businessId]
      );
      prevNombre = prevRows[0]?.nombre || null;
    } catch (_) { }

    const sets = [];
    const vals = [];
    const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    let todoRenamedOutOfTodo = false;

    if (req.body?.nombre !== undefined) {
      const nombre = String(req.body.nombre ?? '').trim();
      if (!nombre) {
        return res.status(400).json({ ok: false, error: 'El nombre no puede quedar vacío' });
      }

      // 🚫 No permitir renombrar "Discontinuados"
      if (prevNombre && isDiscontinuadosName(prevNombre) && nombre !== prevNombre) {
        return res.status(400).json({ ok: false, error: 'La agrupación "Discontinuados" no se puede renombrar' });
      }

      // ✅ Si era el grupo automático (Sin Agrupación/TODO) y pasa a otro nombre → disparar recreación del TODO
      if (prevNombre && isTodoName(prevNombre) && !isTodoName(nombre)) {
        todoRenamedOutOfTodo = true;
      }

      push('nombre', nombre);
    }

    if (req.body?.articulos !== undefined) {
      const articulos = toItemsArray(req.body.articulos);
      push('articulos', JSON.stringify(articulos));
    }

    if (!sets.length) return res.json({ ok: true, data: null });

    const sql = `
  UPDATE agrupaciones
     SET ${sets.join(', ')}, updated_at = NOW()
   WHERE id = $${vals.length + 1}
     AND business_id = $${vals.length + 2}
   RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`;
    const { rows } = await pool.query(sql, [...vals, id, businessId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });

    const updated = rows[0];

    // 🔁 Si sacamos al grupo del "rol automático", nos aseguramos de recrear "Sin Agrupacion"
    if (todoRenamedOutOfTodo) {
      try {
        await pool.query(
          `INSERT INTO agrupaciones (business_id, nombre, articulos)
       VALUES ($1, $2, '[]'::jsonb)
       ON CONFLICT (business_id, nombre) DO NOTHING`,
          [businessId, TODO_NAME_INITIAL]
        );
      } catch (_) { }

      // y garantizamos también que exista "Discontinuados"
      try {
        await pool.query(
          `INSERT INTO agrupaciones (business_id, nombre, articulos)
       VALUES ($1, $2, '[]'::jsonb)
       ON CONFLICT (business_id, nombre) DO NOTHING`,
          [businessId, DISC_NAME]
        );
      } catch (_) { }
    }

    return res.json(updated);

  } catch (e) {
    console.error('actualizarAgrupacion error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// DELETE /businesses/:businessId/agrupaciones/:id
exports.eliminarAgrupacion = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // mirar nombre antes de borrar
    const { rows: prevRows } = await pool.query(
      `SELECT nombre FROM agrupaciones WHERE id=$1 AND business_id=$2`,
      [id, businessId]
    );
    if (!prevRows.length) {
      return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });
    }

    const nombre = prevRows[0].nombre || '';
    if (isTodoName(nombre) || isDiscontinuadosName(nombre)) {
      return res.status(400).json({ ok: false, error: 'Esta agrupación especial no se puede eliminar' });
    }

    const r = await pool.query(
      `DELETE FROM agrupaciones WHERE id=$1 AND business_id=$2`,
      [id, businessId]
    );

    // Limpieza de exclusiones (si existen)
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
    const businessId = getBusinessId(req);
    const id = Number(req.params.id ?? req.params.agrupacionId);
    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Puede venir `articulos` (objetos) o `ids` (números)
    const incomingArticulos = toItemsArray(req.body?.articulos);
    const incomingIds = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.map(Number))].filter(Number.isFinite)
      : [];

    const incoming = incomingArticulos.length
      ? incomingArticulos
      : incomingIds.map((x) => ({
        id: x, nombre: '', categoria: 'Sin categoría', subrubro: 'Sin subrubro', precio: 0
      }));

    if (!incoming.length) {
      return res.status(400).json({ ok: false, error: 'Sin artículos para agregar' });
    }

    // Traer agrupación
    const { rows: r0 } = await pool.query(
      `SELECT articulos FROM agrupaciones WHERE id=$1 AND business_id=$2`,
      [id, businessId]
    );
    if (!r0.length) {
      return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });
    }

    const base = parseJsonArrayLoose(r0[0].articulos);
    const merged = mergeJsonById(base, incoming);

    const { rows } = await pool.query(
      `UPDATE agrupaciones
         SET articulos = $1::jsonb, updated_at = NOW()
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
    const businessId = getBusinessId(req);
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
          SET articulos = $1::jsonb, updated_at = NOW()
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
// Body: { nombre: string, ids?: number[] }  (opcional: articulos:[{...}] si querés enriquecer)
exports.createOrMoveAgrupacion = async (req, res) => {
  const businessId = getBusinessId(req);
  const nombre = String(req.body?.nombre || '').trim();
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);

  if (!Number.isFinite(businessId) || !nombre || !ids.length) {
    return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) crear o encontrar la agrupación destino
    let destRow;
    {
      const r = await client.query(
        `SELECT id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos
           FROM agrupaciones
          WHERE business_id=$1 AND nombre=$2
          FOR UPDATE`,
        [businessId, nombre]
      );
      if (r.rows.length) {
        destRow = r.rows[0];
      } else {
        const r2 = await client.query(
          `INSERT INTO agrupaciones (business_id, nombre, articulos)
           VALUES ($1, $2, '[]'::jsonb)
           RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`,
          [businessId, nombre]
        );
        destRow = r2.rows[0];
      }
    }

    const destId = Number(destRow.id);

    // 2) bloquear todas las agrupaciones del negocio para operar en memoria
    const { rows: groups } = await client.query(
      `SELECT id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos
         FROM agrupaciones
        WHERE business_id=$1
        FOR UPDATE`,
      [businessId]
    );

    const idsSet = new Set(ids);
    let moved = 0;

    // 3) quitar ids de TODAS las otras agrupaciones
    for (const g of groups) {
      const gid = Number(g.id);
      const list = parseJsonArrayLoose(g.articulos);
      if (gid === destId) continue;

      const filtered = list.filter(a => !idsSet.has(Number(a?.id)));
      if (filtered.length !== list.length) {
        await client.query(
          `UPDATE agrupaciones SET articulos=$1::jsonb WHERE id=$2 AND business_id=$3`,
          [JSON.stringify(filtered), gid, businessId]
        );
      }
    }

    // 4) agregar ids (sin duplicar) a la agrupación destino
    {
      const list = parseJsonArrayLoose(destRow.articulos);
      const seen = new Set(list.map(a => Number(a?.id)));
      const toAdd = [];

      for (const id of ids) {
        if (!seen.has(id)) {
          toAdd.push({ id, nombre: '', categoria: 'Sin categoría', subrubro: 'Sin subrubro', precio: 0 });
          seen.add(id);
          moved++;
        }
      }

      if (toAdd.length) {
        const merged = [...list, ...toAdd];
        await client.query(
          `UPDATE agrupaciones SET articulos=$1::jsonb WHERE id=$2 AND business_id=$3`,
          [JSON.stringify(merged), destId, businessId]
        );
      }
    }

    await client.query('COMMIT');
    return res.json({ ok: true, id: destId, nombre, moved });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('createOrMoveAgrupacion error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

// PUT /businesses/:businessId/agrupaciones/todo
// Devuelve el grupo automático de "sobrantes" (Sin Agrupacion).
// Además garantiza que exista también "Discontinuados".
exports.ensureTodoAgrupacion = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'businessId requerido' });
    }

    // 1) ¿Ya hay un grupo "Sin Agrupacion / Sin Agrupación / TODO"?
    const { rows: all } = await pool.query(
      `SELECT id, nombre
         FROM agrupaciones
        WHERE business_id = $1`,
      [businessId]
    );

    let todoRow = all.find(r => isTodoName(r.nombre)) || null;
    let discRow = all.find(r => isDiscontinuadosName(r.nombre)) || null;

    // 2) Si no existe TODO → crearlo
    if (!todoRow) {
      const { rows } = await pool.query(
        `INSERT INTO agrupaciones (business_id, nombre, articulos)
         VALUES ($1, $2, '[]'::jsonb)
         ON CONFLICT (business_id, nombre) DO UPDATE SET nombre=EXCLUDED.nombre
         RETURNING id, nombre`,
        [businessId, TODO_NAME_INITIAL]
      );
      todoRow = rows[0];
    }

    // 3) Asegurar también "Discontinuados"
    if (!discRow) {
      try {
        await pool.query(
          `INSERT INTO agrupaciones (business_id, nombre, articulos)
           VALUES ($1, $2, '[]'::jsonb)
           ON CONFLICT (business_id, nombre) DO NOTHING`,
          [businessId, DISC_NAME]
        );
      } catch (_) { }
    }

    return res.json(todoRow);
  } catch (e) {
    console.error('ensureTodoAgrupacion error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// GET /businesses/:businessId/agrupaciones/:id/exclusiones
exports.listarExclusiones = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
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
      if (e.code === '42P01') return res.json([]); // tabla aún no creada
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
    const businessId = getBusinessId(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const mode = String(req.body?.mode || '').toLowerCase();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!['add', 'remove'].includes(mode) || !items.length) {
      return res.status(400).json({ ok: false, error: 'payload inválido' });
    }

    // tabla (por si aún no existe)
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
  const businessId = getBusinessId(req);
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

/* ========================= Default Group ========================= */

// PATCH /businesses/:businessId/agrupaciones/default
exports.setDefaultGroup = async (req, res) => {
  const businessId = getBusinessId(req);
  const groupId = Number(req.body?.groupId);
  if (!Number.isFinite(businessId) || !Number.isFinite(groupId)) {
    return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
  }

  // validar pertenencia del grupo al negocio
  const { rows } = await pool.query(
    `SELECT 1 FROM agrupaciones WHERE id=$1 AND business_id=$2`,
    [groupId, businessId]
  );
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'group_not_found' });

  await pool.query(
    `UPDATE app_businesses SET default_group_id=$1 WHERE id=$2`,
    [groupId, businessId]
  );
  res.json({ ok: true, default_group_id: groupId });
};

// GET /businesses/:businessId/agrupaciones/default
exports.getDefaultGroup = async (req, res) => {
  const businessId = getBusinessId(req);
  if (!Number.isFinite(businessId)) {
    return res.status(400).json({ ok: false, error: 'businessId requerido' });
  }
  const { rows } = await pool.query(
    `SELECT default_group_id FROM app_businesses WHERE id=$1`, [businessId]
  );
  res.json({ default_group_id: rows[0]?.default_group_id ?? null });
};