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
    const raw = typeof x === 'string' ? x : String(x);
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j.filter(Boolean) : [];
  } catch {
    return [];
  }
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

const normName = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const isTodoName = (s) => {
  const n = normName(s);
  return n === 'sin agrupacion' || n === 'sin agrupación' || n === 'sin agrupacion';
};

const isDiscontinuadosName = (s) => {
  const n = normName(s);
  return n === 'discontinuados' || n === 'descontinuados';
};

/* ========================= AGRUPACIONES (tabla: agrupaciones) ========================= */

// ============================================================================
// GET /businesses/:businessId/agrupaciones
// ✅ SIEMPRE devuelve TODAS las agrupaciones del negocio
// ✅ Sin filtrado por división
exports.obtenerAgrupaciones = async (req, res) => {
  try {
    const businessId = Number(req.params.businessId);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'businessId inválido' });
    }

    const { rows } = await pool.query(
      `
      SELECT a.id, a.nombre, a.business_id,
             COALESCE(NULLIF(a.articulos::text,'')::jsonb,'[]'::jsonb) AS articulos,
             a.app_articles_ids,
             a.is_temporary,
             a.moved_to_business_id
      FROM agrupaciones a
      WHERE a.business_id = $1
      ORDER BY a.id ASC
      `,
      [businessId]
    );

    // ¿Es un subnegocio creado desde agrupación?
    const { rows: bizRows } = await pool.query(
      'SELECT created_from, organization_id FROM app_businesses WHERE id = $1',
      [businessId]
    );
    const isSubBusiness = bizRows[0]?.created_from === 'from_group';
    const organizationId = bizRows[0]?.organization_id;

    let agrupaciones = rows || [];

    if (isSubBusiness) {
      // Filtrar: ocultar agrupaciones movidas a otros subnegocios
      // MANTENER: Sin Agrupación propia del subnegocio (is_temporary) y agrupaciones creadas aquí
      // ELIMINAR: Discontinuados propio (viene del principal) y movidas
      agrupaciones = agrupaciones.filter(ag => {
        if (ag.moved_to_business_id) return false;         // ya fue dividida
        if (isDiscontinuadosName(ag.nombre)) return false; // Discontinuados viene del principal
        return true;
      });

      // Inyectar SOLO Discontinuados del negocio principal de la org
      // (Sin Agrupación es propia de cada subnegocio — cada uno tiene la suya)
      if (organizationId) {
        const { rows: principalRows } = await pool.query(
          `SELECT id FROM app_businesses
            WHERE organization_id = $1
            ORDER BY created_at ASC
            LIMIT 1`,
          [organizationId]
        );
        const principalId = principalRows[0]?.id;

        if (principalId && Number(principalId) !== Number(businessId)) {
          const { rows: discRows } = await pool.query(
            `SELECT id, nombre, business_id,
                    COALESCE(NULLIF(articulos::text,'')::jsonb,'[]'::jsonb) AS articulos,
                    app_articles_ids, is_temporary, moved_to_business_id
               FROM agrupaciones
              WHERE business_id = $1
                AND (
                  nombre ILIKE 'Discontinuados'
                  OR nombre ILIKE 'Descontinuados'
                )
              LIMIT 1`,
            [principalId]
          );

          if (discRows.length) {
            const globalDisc = {
              ...discRows[0],
              global_from_principal: true,
              principal_business_id: principalId,
            };
            // Discontinuados siempre al final
            agrupaciones = [...agrupaciones, globalDisc];
          }
        }
      }
    } else {
      // Negocio principal: ocultar las agrupaciones que ya fueron movidas a subnegocios
      agrupaciones = agrupaciones.filter(ag => !ag.moved_to_business_id);
    }

    // ── orgAssignedIds: IDs asignados en CUALQUIER agrupación real de la org ──
    // El frontend lo usa para calcular Sin Agrupación global correctamente.
    // "Real" = no es Sin Agrupación ni Discontinuados (esos son el contenedor del resto).
    let orgAssignedIds = null;
    if (organizationId) {
      const { rows: orgAgRows } = await pool.query(
        `SELECT ag.articulos, ag.app_articles_ids
           FROM agrupaciones ag
           JOIN app_businesses b ON b.id = ag.business_id
          WHERE b.organization_id = $1
            AND ag.moved_to_business_id IS NULL
            AND ag.nombre NOT ILIKE 'Sin Agrupac%'
            AND ag.nombre NOT ILIKE 'Sin Agrupar%'
            AND ag.nombre NOT ILIKE 'Discontinuados'
            AND ag.nombre NOT ILIKE 'Descontinuados'`,
        [organizationId]
      );
      orgAssignedIds = [];
      for (const ag of orgAgRows) {
        const arts = Array.isArray(ag.articulos) ? ag.articulos
          : (typeof ag.articulos === 'string' ? JSON.parse(ag.articulos || '[]') : []);
        const appIds = Array.isArray(ag.app_articles_ids) ? ag.app_articles_ids
          : (typeof ag.app_articles_ids === 'string' ? JSON.parse(ag.app_articles_ids || '[]') : []);
        for (const a of arts) {
          const id = Number(a?.id ?? a?.articulo_id ?? a);
          if (id > 0) orgAssignedIds.push(id);
        }
        for (const id of appIds) { const n = Number(id); if (n > 0) orgAssignedIds.push(n); }
      }
      // Deduplicar
      orgAssignedIds = [...new Set(orgAssignedIds)];
    }

    return res.json({ ok: true, agrupaciones, orgAssignedIds });
  } catch (e) {
    console.error('obtenerAgrupaciones error', e);
    return res.status(500).json({ ok: false, error: 'Error obteniendo agrupaciones', detail: e.message });
  }
};

// ============================================================================
// POST /businesses/:businessId/agrupaciones
// Body: { nombre, articulos?: [...] }
// ============================================================================
exports.crearAgrupacion = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'business_id requerido' });
    }

    const nombre = String(req.body?.nombre ?? '').trim();
    const articulos = toItemsArray(req.body?.articulos);

    if (!nombre) {
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio' });
    }

    const { rows } = await pool.query(
      `INSERT INTO agrupaciones (business_id, nombre, articulos)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`,
      [bizId, nombre, JSON.stringify(articulos)]
    );

    return res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res
        .status(409)
        .json({ ok: false, error: 'Ya existe una agrupación con ese nombre' });
    }
    console.error('crearAgrupacion error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ============================================================================
// PUT /businesses/:businessId/agrupaciones/:id
// Body: { nombre?, articulos? }
// ============================================================================
exports.actualizarAgrupacion = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    const id = Number(req.params.id);

    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Saber nombre previo (para proteger especiales)
    let prevNombre = null;
    try {
      const { rows: prevRows } = await pool.query(
        `SELECT nombre FROM agrupaciones WHERE id = $1 AND business_id = $2`,
        [id, businessId]
      );
      prevNombre = prevRows[0]?.nombre || null;
    } catch (_) {}

    const sets = [];
    const vals = [];
    const push = (col, val) => {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    };

    let todoRenamedOutOfTodo = false;

    if (req.body?.nombre !== undefined) {
      const nombre = String(req.body.nombre ?? '').trim();
      if (!nombre) {
        return res.status(400).json({ ok: false, error: 'El nombre no puede quedar vacío' });
      }

      // 🚫 No renombrar Discontinuados
      if (prevNombre && isDiscontinuadosName(prevNombre) && nombre !== prevNombre) {
        return res.status(400).json({
          ok: false,
          error: 'La agrupación "Discontinuados" no se puede renombrar',
        });
      }

      // ✅ Si era TODO y deja de serlo => recrear "Sin Agrupacion"
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
       RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos
    `;

    const { rows } = await pool.query(sql, [...vals, id, businessId]);
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });
    }

    const updated = rows[0];

    // 🔁 si sacamos al grupo del rol automático, garantizamos que exista TODO y Discontinuados
    if (todoRenamedOutOfTodo) {
      try {
        await pool.query(
          `INSERT INTO agrupaciones (business_id, nombre, articulos)
           VALUES ($1, $2, '[]'::jsonb)
           ON CONFLICT (business_id, nombre) DO NOTHING`,
          [businessId, TODO_NAME_INITIAL]
        );
      } catch (_) {}

      try {
        await pool.query(
          `INSERT INTO agrupaciones (business_id, nombre, articulos)
           VALUES ($1, $2, '[]'::jsonb)
           ON CONFLICT (business_id, nombre) DO NOTHING`,
          [businessId, DISC_NAME]
        );
      } catch (_) {}
    }

    return res.json(updated);
  } catch (e) {
    console.error('actualizarAgrupacion error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ============================================================================
// DELETE /businesses/:businessId/agrupaciones/:id
// ============================================================================
exports.eliminarAgrupacion = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    const id = Number(req.params.id);

    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const { rows: prevRows } = await pool.query(
      `SELECT nombre FROM agrupaciones WHERE id=$1 AND business_id=$2`,
      [id, businessId]
    );

    if (!prevRows.length) {
      return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });
    }

    const nombre = prevRows[0].nombre || '';
    if (isTodoName(nombre) || isDiscontinuadosName(nombre)) {
      return res
        .status(400)
        .json({ ok: false, error: 'Esta agrupación especial no se puede eliminar' });
    }

    await pool.query(`DELETE FROM agrupaciones WHERE id=$1 AND business_id=$2`, [
      id,
      businessId,
    ]);

    // Limpieza best-effort de exclusiones si hay tabla
    try {
      await pool.query(
        `DELETE FROM agrupacion_exclusiones WHERE agrupacion_id=$1 AND business_id=$2`,
        [id, businessId]
      );
    } catch (_) {}

    return res.json({ ok: true });
  } catch (e) {
    console.error('eliminarAgrupacion error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ============================================================================
// PUT /businesses/:businessId/agrupaciones/:id/articulos
// Body: { articulos?: [...], ids?: [1,2,3] , articuloIds?: [1,2,3] }
// ============================================================================
exports.agregarArticulosAgrupacion = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    const id = Number(req.params.id ?? req.params.agrupacionId);

    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Puede venir `articulos` (objetos) o `ids` o `articuloIds` (números)
    const incomingArticulos = toItemsArray(req.body?.articulos);

    const rawIds =
      Array.isArray(req.body?.ids) ? req.body.ids :
      Array.isArray(req.body?.articuloIds) ? req.body.articuloIds :
      [];

    const incomingIds = Array.isArray(rawIds)
      ? [...new Set(rawIds.map(Number))].filter(Number.isFinite)
      : [];

    const incoming = incomingArticulos.length
      ? incomingArticulos
      : incomingIds.map((x) => ({
          id: x,
          nombre: '',
          categoria: 'Sin categoría',
          subrubro: 'Sin subrubro',
          precio: 0,
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
    console.error('agregarArticulosAgrupacion error:', {
      code: e.code,
      detail: e.detail,
      msg: e.message,
    });
    return res.status(500).json({
      ok: false,
      error: e.message,
      code: e.code,
      detail: e.detail,
    });
  }
};

// ============================================================================
// DELETE /businesses/:businessId/agrupaciones/:id/articulos/:articuloId
// ============================================================================
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

    if (!r0.length) {
      return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });
    }

    const base = parseJsonArrayLoose(r0[0].articulos);
    const filtered = base.filter((a) => Number(a.id) !== articuloId);

    const { rows } = await pool.query(
      `UPDATE agrupaciones
          SET articulos = $1::jsonb, updated_at = NOW()
        WHERE id = $2 AND business_id = $3
        RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`,
      [JSON.stringify(filtered), id, businessId]
    );

    return res.json(rows[0]);
  } catch (e) {
    console.error('eliminarArticuloDeAgrupacion error:', {
      code: e.code,
      detail: e.detail,
      msg: e.message,
    });
    return res.status(500).json({
      ok: false,
      error: e.message,
      code: e.code,
      detail: e.detail,
    });
  }
};

// ============================================================================
// POST /businesses/:businessId/agrupaciones/create-or-move
// Body: { nombre: string, ids: number[] }
// ============================================================================

function extractArticuloId(a) {
  if (a == null) return null;

  // si viene como número directo
  if (typeof a === 'number') {
    const n = Number(a);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // si viene como string numérica
  if (typeof a === 'string') {
    const n = Number(a);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // si viene como objeto con distintas keys
  if (typeof a === 'object') {
    const raw =
      a.id ??
      a.articulo_id ??
      a.article_id ??
      a.articuloId ??
      a.idArticulo ??
      a.codigo ??
      a.codigoArticulo ??
      a.code;

    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  return null;
}

exports.createOrMoveAgrupacion = async (req, res) => {
  let businessId = getBusinessId(req);
  const nombre = String(req.body?.nombre || '').trim();
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!Number.isFinite(businessId) || !nombre || !ids.length) {
    return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
  }

  // Si el destino es "Discontinuados" y es subnegocio,
  // redirigir al Discontinuados del negocio principal de la org
  if (isDiscontinuadosName(nombre)) {
    const { rows: bizRows } = await pool.query(
      `SELECT b.created_from, b.organization_id
         FROM app_businesses b
        WHERE b.id = $1`,
      [businessId]
    );
    const biz = bizRows[0];
    if (biz?.created_from === 'from_group' && biz?.organization_id) {
      // Buscar el negocio más antiguo de la org (el principal)
      const { rows: orgBiz } = await pool.query(
        `SELECT id FROM app_businesses
          WHERE organization_id = $1
          ORDER BY created_at ASC
          LIMIT 1`,
        [biz.organization_id]
      );
      if (orgBiz[0]?.id) {
        businessId = orgBiz[0].id;
        console.log(`[createOrMoveAgrupacion] Redirigiendo Discontinuados al negocio principal ${businessId}`);
      }
    }
  }

  const idsSet = new Set(ids);

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

    // 2) bloquear todas las agrupaciones del negocio
    const { rows: groups } = await client.query(
      `SELECT id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos
         FROM agrupaciones
        WHERE business_id=$1
        FOR UPDATE`,
      [businessId]
    );

    // 3) quitar ids de TODAS las otras agrupaciones (mover real)
    for (const g of groups) {
      const gid = Number(g.id);
      if (gid === destId) continue;

      const list = parseJsonArrayLoose(g.articulos);

      const filtered = list.filter((a) => {
        const aid = extractArticuloId(a);
        return !(aid != null && idsSet.has(aid));
      });

      if (filtered.length !== list.length) {
        await client.query(
          `UPDATE agrupaciones SET articulos=$1::jsonb WHERE id=$2 AND business_id=$3`,
          [JSON.stringify(filtered), gid, businessId]
        );
      }
    }

    // 4) agregar ids (sin duplicar) a la agrupación destino
    let moved = 0;
    {
      const list = parseJsonArrayLoose(destRow.articulos);

      const seen = new Set(
        list
          .map(extractArticuloId)
          .filter((n) => n != null)
      );

      const toAdd = [];
      for (const id of ids) {
        if (!seen.has(id)) {
          toAdd.push({ id }); // ✅ mínimo, limpio
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

// ============================================================================
// PUT /businesses/:businessId/agrupaciones/todo
// Garantiza que exista "Sin Agrupación/TODO" y "Discontinuados".
// ============================================================================
exports.ensureTodoAgrupacion = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'businessId requerido' });
    }

    const { rows: all } = await pool.query(
      `SELECT id, nombre
         FROM agrupaciones
        WHERE business_id = $1`,
      [businessId]
    );

    let todoRow = all.find((r) => isTodoName(r.nombre)) || null;
    let discRow = all.find((r) => isDiscontinuadosName(r.nombre)) || null;

    if (!todoRow) {
      const { rows } = await pool.query(
        `INSERT INTO agrupaciones (business_id, nombre, articulos)
         VALUES ($1, $2, '[]'::jsonb)
         ON CONFLICT (business_id, nombre) DO NOTHING
         RETURNING id, nombre`,
        [businessId, TODO_NAME_INITIAL]
      );

      // si por carrera no devolvió, buscá
      todoRow = rows[0] || (await pool.query(
        `SELECT id, nombre FROM agrupaciones WHERE business_id=$1 AND nombre=$2 LIMIT 1`,
        [businessId, TODO_NAME_INITIAL]
      )).rows[0];
    }

    // Solo crear Discontinuados en el negocio principal (no en subnegocios)
    if (!discRow) {
      const { rows: bizCheck } = await pool.query(
        'SELECT created_from FROM app_businesses WHERE id = $1',
        [businessId]
      );
      const isSub = bizCheck[0]?.created_from === 'from_group';
      if (!isSub) {
        try {
          await pool.query(
            `INSERT INTO agrupaciones (business_id, nombre, articulos)
             VALUES ($1, $2, '[]'::jsonb)
             ON CONFLICT (business_id, nombre) DO NOTHING`,
            [businessId, DISC_NAME]
          );
        } catch (_) {}
      }
    }

    return res.json(todoRow);
  } catch (e) {
    console.error('ensureTodoAgrupacion error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ============================================================================
// GET /businesses/:businessId/agrupaciones/:id/exclusiones
// ============================================================================
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

// ============================================================================
// POST /businesses/:businessId/agrupaciones/:id/exclusiones
// Body: { mode: 'add'|'remove', items:[{scope, ref_id}] }
// ============================================================================
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

    // tabla (si aún no existe)
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

          // Nota: sin constraint unique, ON CONFLICT no sirve.
          // Si querés idempotencia perfecta, agregamos UNIQUE(business_id,agrupacion_id,scope,ref_id).
          const r = await client.query(
            `INSERT INTO agrupacion_exclusiones (business_id, agrupacion_id, scope, ref_id)
             VALUES ($1, $2, $3, $4)`,
            [businessId, id, scope, ref_id]
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
      // remove
      const params = [];
      const conds = [];
      let i = 1;

      for (const raw of items) {
        const scope = String(raw.scope || '').toLowerCase();
        const ref_id = String(raw.ref_id ?? '').trim();
        if (!['categoria', 'subrubro', 'articulo'].includes(scope) || !ref_id) continue;

        params.push(businessId, id, scope, ref_id);
        conds.push(
          `(business_id=$${i++} AND agrupacion_id=$${i++} AND scope=$${i++} AND ref_id=$${i++})`
        );
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

// ============================================================================
// POST /businesses/:businessId/agrupaciones/:fromId/move-items
// Body: { toId, ids: number[] }
// ============================================================================
exports.moveItemsBetweenGroups = async (req, res) => {
  const businessId = getBusinessId(req);
  const fromId = Number(req.params.id ?? req.params.fromId);
  const toId = Number(req.body?.toId);
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number)
    .filter(Boolean);

  if (
    !Number.isFinite(businessId) ||
    !Number.isFinite(fromId) ||
    !Number.isFinite(toId) ||
    !ids.length
  ) {
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

    const fromRow = rows.find((r) => Number(r.id) === fromId);
    const toRow = rows.find((r) => Number(r.id) === toId);

    if (!fromRow || !toRow) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Agrupación/es no encontrada/s' });
    }

    const fromList = parseJsonArrayLoose(fromRow.articulos);
    const toList = parseJsonArrayLoose(toRow.articulos);

    const idsSet = new Set(ids);
    const moving = fromList.filter((a) => idsSet.has(Number(a.id)));

    if (!moving.length) {
      await client.query('COMMIT');
      return res.json({ ok: true, moved: 0 });
    }

    const seen = new Set(toList.map((x) => Number(x.id)));
    const toMerged = [...toList];

    for (const it of moving) {
      const id = Number(it.id);
      if (!seen.has(id)) {
        toMerged.push({ ...it, id });
        seen.add(id);
      }
    }

    const fromFiltered = fromList.filter((a) => !idsSet.has(Number(a.id)));

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
    console.error('moveItemsBetweenGroups error:', {
      code: e.code,
      detail: e.detail,
      msg: e.message,
    });
    return res.status(500).json({ ok: false, error: e.message, code: e.code, detail: e.detail });
  } finally {
    client.release();
  }
};

/* ========================= Default Group (app_businesses.default_group_id) ========================= */

// PATCH /businesses/:businessId/agrupaciones/default
exports.setDefaultGroup = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    const groupId = Number(req.body?.groupId);

    if (!Number.isFinite(businessId) || !Number.isFinite(groupId)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const { rows } = await pool.query(
      `SELECT 1 FROM agrupaciones WHERE id=$1 AND business_id=$2`,
      [groupId, businessId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'group_not_found' });

    await pool.query(`UPDATE app_businesses SET default_group_id=$1 WHERE id=$2`, [
      groupId,
      businessId,
    ]);

    return res.json({ ok: true, default_group_id: groupId });
  } catch (e) {
    console.error('setDefaultGroup error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// GET /businesses/:businessId/agrupaciones/default
exports.getDefaultGroup = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'businessId requerido' });
    }
    const { rows } = await pool.query(`SELECT default_group_id FROM app_businesses WHERE id=$1`, [
      businessId,
    ]);
    return res.json({ default_group_id: rows[0]?.default_group_id ?? null });
  } catch (e) {
    console.error('getDefaultGroup error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

/* ========================= Division assignment (division_agrupacion_assignments) ========================= */

// POST /businesses/:businessId/agrupaciones/:groupId/assign-division
// Body: { divisionId: number|null }
exports.assignAgrupacionToDivision = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'business_id requerido' });
    }

    const groupId = Number(req.params.groupId);
    if (!Number.isFinite(groupId)) {
      return res.status(400).json({ ok: false, error: 'groupId inválido' });
    }

    const divisionIdRaw = req.body?.divisionId;
    const divisionId =
      divisionIdRaw === null ||
      divisionIdRaw === undefined ||
      divisionIdRaw === '' ||
      divisionIdRaw === 'null'
        ? null
        : Number(divisionIdRaw);

    // 1) validar que la agrupación sea del negocio
    const g = await pool.query(`SELECT id, business_id FROM agrupaciones WHERE id = $1 LIMIT 1`, [
      groupId,
    ]);
    if (!g.rows?.length) {
      return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });
    }
    if (Number(g.rows[0].business_id) !== Number(businessId)) {
      return res.status(403).json({ ok: false, error: 'Agrupación no pertenece a este negocio' });
    }

    // 2) si divisionId es null => "volver a principal"
    if (!Number.isFinite(divisionId)) {
      await pool.query(
        `
        DELETE FROM division_agrupacion_assignments daa
        USING business_divisions bd
        WHERE daa.division_id = bd.id
          AND bd.business_id = $1
          AND daa.agrupacion_id = $2
        `,
        [businessId, groupId]
      );
      return res.json({ ok: true, action: 'unassigned_to_main', groupId, divisionId: null });
    }

    // 3) validar que la división pertenezca al negocio
    const d = await pool.query(
      `SELECT id FROM business_divisions WHERE id = $1 AND business_id = $2 LIMIT 1`,
      [divisionId, businessId]
    );
    if (!d.rows?.length) {
      return res.status(404).json({ ok: false, error: 'División no encontrada para este negocio' });
    }

    // 4) mover: borrar asignaciones previas de esa agrupación dentro del negocio
    await pool.query(
      `
      DELETE FROM division_agrupacion_assignments daa
      USING business_divisions bd
      WHERE daa.division_id = bd.id
        AND bd.business_id = $1
        AND daa.agrupacion_id = $2
      `,
      [businessId, groupId]
    );

    // 5) insertar nueva
    await pool.query(
      `
      INSERT INTO division_agrupacion_assignments (division_id, agrupacion_id)
      VALUES ($1, $2)
      ON CONFLICT (division_id, agrupacion_id) DO NOTHING
      `,
      [divisionId, groupId]
    );

    return res.json({ ok: true, action: 'assigned', groupId, divisionId });
  } catch (e) {
    console.error('assignAgrupacionToDivision error', e);
    return res.status(500).json({
      ok: false,
      error: 'Error asignando agrupación',
      detail: e.message,
    });
  }
};