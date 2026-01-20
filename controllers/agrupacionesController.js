// controllers/agrupacionesController.js
const pool = require('../config/db');

/* ═══════════════════════════════════════════════════════════════════════════
   🆕 HELPER PARA SUBNEGOCIOS
   Detecta si un businessId es un subnegocio y retorna el contexto correcto
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Obtiene el contexto de negocio/subnegocio
 * @param {number} businessId - ID del negocio a verificar
 * @returns {Promise<{
 *   isSubnegocio: boolean,
 *   effectiveId: number,
 *   parentId: number|null,
 *   agrupacionIds: number[]
 * }>}
 */
async function getBusinessContext(businessId) {
  // Obtener información del negocio
  const { rows: bizRows } = await pool.query(`
    SELECT id, parent_id 
    FROM app_businesses 
    WHERE id = $1
  `, [businessId]);

  if (!bizRows.length) {
    throw Object.assign(new Error('business_not_found'), { status: 404 });
  }

  const biz = bizRows[0];
  const isSubnegocio = !!biz.parent_id;
  const effectiveId = isSubnegocio ? biz.parent_id : businessId;
  
  let agrupacionIds = [];
  
  // Si es subnegocio, obtener agrupaciones asignadas
  if (isSubnegocio) {
    const { rows: agrupRows } = await pool.query(`
      SELECT agrupacion_id 
      FROM business_agrupaciones 
      WHERE business_id = $1
    `, [businessId]);
    
    agrupacionIds = agrupRows.map(r => r.agrupacion_id);
  }

  return {
    isSubnegocio,
    effectiveId,      // ID del negocio principal (o el mismo si no es subnegocio)
    parentId: biz.parent_id,
    agrupacionIds,    // IDs de agrupaciones asignadas (solo si es subnegocio)
    originalId: businessId
  };
}

/* ========================= Helpers ========================= */
const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function getBusinessId(req) {
  const ctx = Number(req.businessId);
  if (Number.isFinite(ctx)) return ctx;
  const p = Number(req.params?.businessId);
  if (Number.isFinite(p)) return p;
  const h = Number(req.header('X-Business-Id'));
  if (Number.isFinite(h)) return h;
  return NaN;
}

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

/* ═══════════════════════════════════════════════════════════════════════════
   🆕 CRUD AGRUPACIONES CON SOPORTE PARA SUBNEGOCIOS
   Si es subnegocio, filtra las agrupaciones asignadas
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /businesses/:businessId/agrupaciones
 * 
 * ANTES: SELECT FROM agrupaciones
 * AHORA: SELECT FROM business_groups + article_groups
 */
exports.obtenerAgrupaciones = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'business_id requerido' });
    }

    // Query que emula la estructura de agrupaciones usando business_groups
    const { rows } = await pool.query(
      `
      SELECT 
        bg.id,
        bg.name as nombre,
        bg.description,
        bg.created_at,
        bg.updated_at,
        -- Reconstruir array de artículos en formato JSONB (compatible)
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', aa.id,
                'nombre', aa.name,
                'categoria', COALESCE(c.nombre, 'Sin categoría'),
                'subrubro', COALESCE(s.nombre, 'Sin subrubro'),
                'precio', COALESCE(aa.price, 0)
              )
              ORDER BY aa.name
            )
            FROM article_groups ag
            INNER JOIN app_articles aa ON aa.id = ag.article_id
            LEFT JOIN categorias c ON c.id = aa.categoria_id
            LEFT JOIN subrubros s ON s.id = aa.subrubro_id
            WHERE ag.group_id = bg.id
          ),
          '[]'::jsonb
        ) as articulos
      FROM business_groups bg
      WHERE bg.business_id = $1
        AND bg.status = 'active'
      ORDER BY bg.id ASC
      `,
      [bizId]
    );

    res.json(rows);
  } catch (e) {
    console.error('obtenerAgrupaciones (adapted) error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

/**
 * POST /businesses/:businessId/agrupaciones
 * 
 * ANTES: INSERT INTO agrupaciones
 * AHORA: INSERT INTO business_groups
 */
exports.crearAgrupacion = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'business_id requerido' });
    }

    const nombre = String(req.body?.nombre ?? '').trim();
    if (!nombre) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio' });
    }

    // Crear en business_groups
    const { rows } = await client.query(
      `
      INSERT INTO business_groups (business_id, name, description, status)
      VALUES ($1, $2, $3, 'active')
      RETURNING id, name as nombre, description, created_at, updated_at, '[]'::jsonb as articulos
      `,
      [bizId, nombre, req.body?.description || null]
    );

    await client.query('COMMIT');

    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ya existe una agrupación con ese nombre' });
    }
    
    console.error('crearAgrupacion (adapted) error:', e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

/**
 * PUT /businesses/:businessId/agrupaciones/:id
 * 
 * ANTES: UPDATE agrupaciones
 * AHORA: UPDATE business_groups
 */
exports.actualizarAgrupacion = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const businessId = getBusinessId(req);
    const id = Number(req.params.id);
    
    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const sets = [];
    const vals = [];
    let i = 1;

    if (req.body?.nombre !== undefined) {
      const nombre = String(req.body.nombre ?? '').trim();
      if (!nombre) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'El nombre no puede quedar vacío' });
      }
      vals.push(nombre);
      sets.push(`name = $${i++}`);
    }

    if (req.body?.description !== undefined) {
      vals.push(req.body.description || null);
      sets.push(`description = $${i++}`);
    }

    if (!sets.length) {
      await client.query('COMMIT');
      return res.json({ ok: true, data: null });
    }

    sets.push(`updated_at = NOW()`);
    vals.push(id, businessId);

    const { rows } = await client.query(
      `
      UPDATE business_groups
      SET ${sets.join(', ')}
      WHERE id = $${i++} AND business_id = $${i++}
      RETURNING id, name as nombre, description, created_at, updated_at
      `,
      vals
    );

    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });
    }

    // Obtener artículos
    const { rows: articulos } = await client.query(
      `
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', aa.id,
          'nombre', aa.name,
          'categoria', COALESCE(c.nombre, 'Sin categoría'),
          'subrubro', COALESCE(s.nombre, 'Sin subrubro'),
          'precio', COALESCE(aa.price, 0)
        )
      ) as articulos
      FROM article_groups ag
      INNER JOIN app_articles aa ON aa.id = ag.article_id
      LEFT JOIN categorias c ON c.id = aa.categoria_id
      LEFT JOIN subrubros s ON s.id = aa.subrubro_id
      WHERE ag.group_id = $1
      `,
      [id]
    );

    await client.query('COMMIT');

    const updated = {
      ...rows[0],
      articulos: articulos[0]?.articulos || []
    };

    return res.json(updated);

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('actualizarAgrupacion (adapted) error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

/**
 * DELETE /businesses/:businessId/agrupaciones/:id
 * 
 * ANTES: DELETE FROM agrupaciones
 * AHORA: DELETE FROM business_groups (CASCADE elimina article_groups)
 */
exports.eliminarAgrupacion = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const businessId = getBusinessId(req);
    const id = Number(req.params.id);
    
    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Verificar que existe
    const { rows: check } = await client.query(
      `SELECT name FROM business_groups WHERE id = $1 AND business_id = $2`,
      [id, businessId]
    );

    if (!check.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });
    }

    // Eliminar (CASCADE limpia article_groups automáticamente)
    await client.query(
      `DELETE FROM business_groups WHERE id = $1 AND business_id = $2`,
      [id, businessId]
    );

    await client.query('COMMIT');

    return res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('eliminarAgrupacion (adapted) error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

/**
 * PUT /businesses/:businessId/agrupaciones/:id/articulos
 * 
 * ANTES: Actualizar JSONB en agrupaciones
 * AHORA: INSERT INTO article_groups
 */
exports.agregarArticulosAgrupacion = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const businessId = getBusinessId(req);
    const id = Number(req.params.id ?? req.params.agrupacionId);
    
    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Puede venir `articulos` (objetos) o `ids` (números)
    let articleIds = [];
    
    if (Array.isArray(req.body?.articulos)) {
      articleIds = req.body.articulos
        .map(a => safeNum(a.id))
        .filter(Boolean);
    } else if (Array.isArray(req.body?.ids)) {
      articleIds = req.body.ids.map(Number).filter(Number.isFinite);
    }

    if (!articleIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'Sin artículos para agregar' });
    }

    // Insertar en article_groups (ON CONFLICT evita duplicados)
    for (const articleId of articleIds) {
      await client.query(
        `
        INSERT INTO article_groups (group_id, article_id)
        VALUES ($1, $2)
        ON CONFLICT (group_id, article_id) DO NOTHING
        `,
        [id, articleId]
      );
    }

    // Retornar grupo actualizado
    const { rows } = await client.query(
      `
      SELECT 
        bg.id,
        bg.name as nombre,
        bg.description,
        bg.created_at,
        bg.updated_at,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', aa.id,
                'nombre', aa.name,
                'categoria', COALESCE(c.nombre, 'Sin categoría'),
                'subrubro', COALESCE(s.nombre, 'Sin subrubro'),
                'precio', COALESCE(aa.price, 0)
              )
            )
            FROM article_groups ag
            INNER JOIN app_articles aa ON aa.id = ag.article_id
            LEFT JOIN categorias c ON c.id = aa.categoria_id
            LEFT JOIN subrubros s ON s.id = aa.subrubro_id
            WHERE ag.group_id = bg.id
          ),
          '[]'::jsonb
        ) as articulos
      FROM business_groups bg
      WHERE bg.id = $1 AND bg.business_id = $2
      `,
      [id, businessId]
    );

    await client.query('COMMIT');

    return res.json(rows[0] || { ok: false, error: 'Grupo no encontrado' });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('agregarArticulosAgrupacion (adapted) error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

/**
 * DELETE /businesses/:businessId/agrupaciones/:id/articulos/:articuloId
 * 
 * ANTES: Quitar del JSONB en agrupaciones
 * AHORA: DELETE FROM article_groups
 */
exports.eliminarArticuloDeAgrupacion = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const businessId = getBusinessId(req);
    const id = Number(req.params.id);
    const articuloId = Number(req.params.articuloId);
    
    if (!Number.isFinite(businessId) || !Number.isFinite(id) || !Number.isFinite(articuloId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Eliminar de article_groups
    await client.query(
      `DELETE FROM article_groups WHERE group_id = $1 AND article_id = $2`,
      [id, articuloId]
    );

    // Retornar grupo actualizado
    const { rows } = await client.query(
      `
      SELECT 
        bg.id,
        bg.name as nombre,
        bg.description,
        bg.created_at,
        bg.updated_at,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', aa.id,
                'nombre', aa.name,
                'categoria', COALESCE(c.nombre, 'Sin categoría'),
                'subrubro', COALESCE(s.nombre, 'Sin subrubro'),
                'precio', COALESCE(aa.price, 0)
              )
            )
            FROM article_groups ag
            INNER JOIN app_articles aa ON aa.id = ag.article_id
            LEFT JOIN categorias c ON c.id = aa.categoria_id
            LEFT JOIN subrubros s ON s.id = aa.subrubro_id
            WHERE ag.group_id = bg.id
          ),
          '[]'::jsonb
        ) as articulos
      FROM business_groups bg
      WHERE bg.id = $1 AND bg.business_id = $2
      `,
      [id, businessId]
    );

    await client.query('COMMIT');

    return res.json(rows[0] || { ok: false, error: 'Grupo no encontrado' });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('eliminarArticuloDeAgrupacion (adapted) error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
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

    // 🆕 Obtener contexto
    const ctx = await getBusinessContext(businessId);

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
            [ctx.effectiveId, id, scope, ref_id]
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
        params.push(ctx.effectiveId, id, scope, ref_id);
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

/* ========================= Default Group ========================= */

// PATCH /businesses/:businessId/agrupaciones/default
exports.setDefaultGroup = async (req, res) => {
  const businessId = getBusinessId(req);
  const groupId = Number(req.body?.groupId);
  if (!Number.isFinite(businessId) || !Number.isFinite(groupId)) {
    return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
  }

  // 🆕 Obtener contexto
  const ctx = await getBusinessContext(businessId);

  // validar pertenencia del grupo al negocio efectivo
  const { rows } = await pool.query(
    `SELECT 1 FROM agrupaciones WHERE id=$1 AND business_id=$2`,
    [groupId, ctx.effectiveId]
  );
  if (!rows[0]) return res.status(404).json({ ok: false, error: 'group_not_found' });

  await pool.query(
    `UPDATE app_businesses SET default_group_id=$1 WHERE id=$2`,
    [groupId, ctx.effectiveId]
  );
  res.json({ ok: true, default_group_id: groupId });
};

// GET /businesses/:businessId/agrupaciones/default
exports.getDefaultGroup = async (req, res) => {
  const businessId = getBusinessId(req);
  if (!Number.isFinite(businessId)) {
    return res.status(400).json({ ok: false, error: 'businessId requerido' });
  }

  // 🆕 Obtener contexto
  const ctx = await getBusinessContext(businessId);

  const { rows } = await pool.query(
    `SELECT default_group_id FROM app_businesses WHERE id=$1`, [ctx.effectiveId]
  );
  res.json({ default_group_id: rows[0]?.default_group_id ?? null });
};

module.exports = {
  obtenerAgrupaciones: exports.obtenerAgrupaciones,
  crearAgrupacion: exports.crearAgrupacion,
  actualizarAgrupacion: exports.actualizarAgrupacion,
  eliminarAgrupacion: exports.eliminarAgrupacion,
  agregarArticulosAgrupacion: exports.agregarArticulosAgrupacion,
  eliminarArticuloDeAgrupacion: exports.eliminarArticuloDeAgrupacion,

  // 👇 agregar estas porque las usás en rutas
  upsertExclusiones: exports.upsertExclusiones,
  listarExclusiones: exports.listarExclusiones,
  ensureTodoAgrupacion: exports.ensureTodoAgrupacion,
  moveItemsBetweenGroups: exports.moveItemsBetweenGroups,
  createOrMoveAgrupacion: exports.createOrMoveAgrupacion,
}
