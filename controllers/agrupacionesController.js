// controllers/agrupacionesController.js
const pool = require('../config/db');
const { invalidateCacheForBiz } = require('../middleware/cacheJson');

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

  // Guardar nombre real si viene; si no, dejar vacío para que el front lo enrichezca desde metaById
  const rawNombre = String(o.nombre ?? o.descripcion ?? '').trim();
  const nombre = rawNombre.startsWith('#') ? '' : rawNombre;
  const categoria = String(o.categoria ?? o.rubro ?? 'Sin categoría').trim() || 'Sin categoría';
  const subrubro = String(o.subrubro ?? o.subRubro ?? 'Sin subrubro').trim() || 'Sin subrubro';
  const precio = Number(o.precio ?? o.precioVenta ?? o.importe ?? 0) || 0;

  const item = { id, nombre, categoria, subrubro, precio };

  // Preservar metadata de origen si viene (usado al discontinuar)
  if (o.fromGroupId != null) item.fromGroupId = Number(o.fromGroupId);
  if (o.fromGroupName != null) item.fromGroupName = String(o.fromGroupName);
  if (o.fromBizId != null) item.fromBizId = Number(o.fromBizId);

  return item;
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
      // ELIMINAR: Discontinuados y Sin Agrupacion propios (son globales, vienen del principal)
      agrupaciones = agrupaciones.filter(ag => {
        if (ag.moved_to_business_id) return false;         // ya fue dividida
        if (isDiscontinuadosName(ag.nombre)) return false; // Discontinuados viene del principal
        if (isTodoName(ag.nombre)) return false;            // Sin Agrupacion viene del principal
        return true;
      });

      // Inyectar Discontinuados Y Sin Agrupacion del principal (son globales)
      // Todos los subnegocios from_group comparten los mismos grupos especiales
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

          // Inyectar Sin Agrupacion del principal (es global, no propia del subnegocio)
          const { rows: todoRows } = await pool.query(
            `SELECT id, nombre, business_id,
                    COALESCE(NULLIF(articulos::text,'')::jsonb,'[]'::jsonb) AS articulos,
                    app_articles_ids, is_temporary, moved_to_business_id
               FROM agrupaciones
              WHERE business_id = $1
                AND (nombre ILIKE 'Sin Agrupaci_n' OR nombre = 'Sin Agrupacion')
              LIMIT 1`,
            [principalId]
          );

          if (todoRows.length) {
            const globalTodo = {
              ...todoRows[0],
              global_from_principal: true,
              principal_business_id: principalId,
            };
            // Sin Agrupacion siempre al principio
            agrupaciones = [globalTodo, ...agrupaciones];
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
          // id !== 0 — acepta negativos (artículos manuales)
          if (Number.isFinite(id) && id !== 0) orgAssignedIds.push(id);
        }
        for (const id of appIds) { const n = Number(id); if (Number.isFinite(n) && n !== 0) orgAssignedIds.push(n); }
      }
      orgAssignedIds = [...new Set(orgAssignedIds)];
    }
    console.log('[obtenerAgrupaciones DEBUG]', {
      businessId,
      isSubBusiness,
      agrupacionesCount: agrupaciones.length,
      agrupaciones: agrupaciones.map(a => ({
        id: a.id,
        nombre: a.nombre,
        business_id: a.business_id,
        global_from_principal: a.global_from_principal,
        articulosCount: Array.isArray(a.articulos) ? a.articulos.length : '?'
      }))
    });
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

    // Verificar si ya existe una agrupación con ese nombre en este negocio
    const { rows: existing } = await pool.query(
      `SELECT id, nombre, moved_to_business_id,
              jsonb_array_length(COALESCE(articulos, '[]'::jsonb)) AS art_count,
              is_temporary
         FROM agrupaciones
        WHERE business_id = $1 AND LOWER(nombre) = LOWER($2)
        LIMIT 1`,
      [bizId, nombre]
    );

    if (existing.length) {
      const dup = existing[0];
      const artCount = Number(dup.art_count ?? 0);
      const isMoved = dup.moved_to_business_id != null;
      const isEmpty = artCount === 0;
      const isSpecial = isTodoName(dup.nombre) || isDiscontinuadosName(dup.nombre);

      if (isSpecial) {
        return res.status(409).json({
          ok: false,
          error: `"${dup.nombre}" es una agrupación especial y no se puede reutilizar`,
        });
      }

      if (isMoved || isEmpty) {
        // La agrupación existente fue movida a otro subnegocio o quedó vacía:
        // la reciclamos (reseteamos moved_to_business_id, cargamos los artículos nuevos)
        const { rows: recycled } = await pool.query(
          `UPDATE agrupaciones
              SET articulos = $1::jsonb,
                  moved_to_business_id = NULL,
                  is_temporary = false,
                  updated_at = NOW()
            WHERE id = $2 AND business_id = $3
            RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`,
          [JSON.stringify(articulos), dup.id, bizId]
        );
        console.log('[crearAgrupacion] Reciclando agrupación "' + nombre + '" (id=' + dup.id + ') en negocio ' + bizId + ' (estaba ' + (isMoved ? 'movida' : 'vacía') + ')');
        return res.status(201).json(recycled[0]);
      }

      // Existe y tiene artículos — conflicto real
      return res.status(409).json({
        ok: false,
        error: `Ya existe una agrupación llamada "${nombre}" con artículos en este negocio`,
      });
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
      // Fallback por race condition
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
    } catch (_) { }

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

      // Si el nombre nuevo ya existe en otro registro del mismo negocio,
      // verificar si ese duplicado es movido/vacío y se puede eliminar para ceder el nombre
      if (prevNombre && nombre.toLowerCase() !== prevNombre.toLowerCase()) {
        const { rows: dupRows } = await pool.query(
          `SELECT id, nombre, moved_to_business_id,
                  jsonb_array_length(COALESCE(articulos, '[]'::jsonb)) AS art_count,
                  is_temporary
             FROM agrupaciones
            WHERE business_id = $1 AND LOWER(nombre) = LOWER($2) AND id != $3
            LIMIT 1`,
          [businessId, nombre, id]
        );
        if (dupRows.length) {
          const dup = dupRows[0];
          const artCount = Number(dup.art_count ?? 0);
          const isMoved = dup.moved_to_business_id != null;
          const isEmpty = artCount === 0;
          const isSpecial = isTodoName(dup.nombre) || isDiscontinuadosName(dup.nombre);

          if (isSpecial || (!isMoved && !isEmpty)) {
            return res.status(409).json({
              ok: false,
              error: `Ya existe una agrupación llamada "${nombre}"${!isEmpty ? ' con artículos' : ''} en este negocio`,
            });
          }

          // Es movida o vacía — eliminarla para liberar el nombre
          await pool.query(
            `DELETE FROM agrupaciones WHERE id = $1 AND business_id = $2`,
            [dup.id, businessId]
          );
          console.log('[actualizarAgrupacion] Eliminando duplicado fantasma "' + dup.nombre + '" (id=' + dup.id + ') para liberar nombre en negocio ' + businessId);
        }
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
      } catch (_) { }

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

// ============================================================================
// DELETE /businesses/:businessId/agrupaciones/:id
// ============================================================================
exports.eliminarAgrupacion = async (req, res) => {
  try {
    const requestBusinessId = getBusinessId(req);
    const id = Number(req.params.id);

    if (!Number.isFinite(requestBusinessId) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Buscar el grupo por id solamente: puede pertenecer al negocio principal
    // (cuando la agrupación "Festejos" original vive en el principal pero se gestiona desde el subnegocio)
    const { rows: prevRows } = await pool.query(
      `SELECT nombre, business_id FROM agrupaciones WHERE id=$1`,
      [id]
    );

    if (!prevRows.length) {
      return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });
    }

    const nombre = prevRows[0].nombre || '';
    const realBusinessId = Number(prevRows[0].business_id);

    // Validar que el negocio del request sea el mismo o pertenezca a la misma organización
    if (realBusinessId !== requestBusinessId) {
      const { rows: orgCheck } = await pool.query(
        `SELECT b1.organization_id AS org1, b2.organization_id AS org2
           FROM app_businesses b1, app_businesses b2
          WHERE b1.id = $1 AND b2.id = $2`,
        [requestBusinessId, realBusinessId]
      );
      const sameOrg = orgCheck[0]?.org1 && orgCheck[0]?.org1 === orgCheck[0]?.org2;
      if (!sameOrg) {
        return res.status(403).json({ ok: false, error: 'No autorizado para eliminar esta agrupación' });
      }
    }

    if (isTodoName(nombre) || isDiscontinuadosName(nombre)) {
      return res
        .status(400)
        .json({ ok: false, error: 'Esta agrupación especial no se puede eliminar' });
    }

    await pool.query(`DELETE FROM agrupaciones WHERE id=$1 AND business_id=$2`, [
      id,
      realBusinessId,
    ]);

    // Limpieza best-effort de exclusiones si hay tabla
    try {
      await pool.query(
        `DELETE FROM agrupacion_exclusiones WHERE agrupacion_id=$1`,
        [id]
      );
    } catch (_) { }

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
    let businessId = Number(req.params.businessId);
    if (!Number.isFinite(businessId)) {
      businessId = getBusinessId(req);
    }

    const id = Number(req.params.id ?? req.params.agrupacionId);
    console.log('[agregarArticulos] businessId:', businessId, '| id:', id);
    console.log('[agregarArticulos] req.params:', req.params);
    console.log('[agregarArticulos] req.businessId:', req.businessId);
    console.log('[agregarArticulos] X-Business-Id header:', req.header('X-Business-Id'));

    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Si el grupo target es Discontinuados y estamos en subnegocio,
    // redirigir al Discontinuados del negocio principal
    {
      const { rows: agRows } = await pool.query(
        `SELECT nombre FROM agrupaciones WHERE id = $1`, [id]
      );
      const agNombre = agRows[0]?.nombre ?? '';
      if (isDiscontinuadosName(agNombre)) {
        const { rows: bizRows } = await pool.query(
          `SELECT created_from, organization_id FROM app_businesses WHERE id = $1`, [businessId]
        );
        const biz = bizRows[0];
        if (biz?.created_from === 'from_group' && biz?.organization_id) {
          const { rows: orgBiz } = await pool.query(
            `SELECT id FROM app_businesses WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1`,
            [biz.organization_id]
          );
          if (orgBiz[0]?.id) {
            console.log(`[agregarArticulosAgrupacion] Redirigiendo Discontinuados de negocio ${businessId} al principal ${orgBiz[0].id}`);
            businessId = orgBiz[0].id;
          }
        }
      }
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
    console.log('[agregarArticulos] query result rows:', r0.length, '| params:', [id, businessId]);

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

    invalidateCacheForBiz(businessId);
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
    const requestBusinessId = Number(req.params.businessId || 0) || getBusinessId(req);
    const id = Number(req.params.id ?? req.params.agrupacionId);
    const articuloId = Number(req.params.articuloId);

    if (!Number.isFinite(requestBusinessId) || !Number.isFinite(id) || !Number.isFinite(articuloId)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Buscar la agrupación por id solo: puede pertenecer al principal o al subnegocio
    const { rows: agRows } = await pool.query(
      `SELECT nombre, business_id FROM agrupaciones WHERE id = $1`, [id]
    );
    if (!agRows.length) {
      return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });
    }

    // Usar SIEMPRE el business_id real de la agrupación (no el del request)
    let businessId = Number(agRows[0].business_id);
    const agNombre = agRows[0]?.nombre ?? '';

    // Solo para Discontinuados: redirigir al principal (comportamiento heredado)
    if (isDiscontinuadosName(agNombre)) {
      const { rows: bizRows } = await pool.query(
        `SELECT created_from, organization_id FROM app_businesses WHERE id = $1`, [requestBusinessId]
      );
      const biz = bizRows[0];
      if (biz?.created_from === 'from_group' && biz?.organization_id) {
        const { rows: orgBiz } = await pool.query(
          `SELECT id FROM app_businesses WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1`,
          [biz.organization_id]
        );
        if (orgBiz[0]?.id) {
          console.log(`[eliminarArticuloDeAgrupacion] Redirigiendo Discontinuados de ${requestBusinessId} al principal ${orgBiz[0].id}`);
          businessId = orgBiz[0].id;
        }
      }
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

    // Limpiar también app_articles_ids (columna legacy)
    await pool.query(
      `UPDATE agrupaciones
          SET app_articles_ids = (
            SELECT jsonb_agg(elem)
            FROM jsonb_array_elements(COALESCE(app_articles_ids, '[]'::jsonb)) AS elem
            WHERE elem::int != $1
          )
        WHERE id = $2 AND business_id = $3
          AND app_articles_ids IS NOT NULL`,
      [articuloId, id, businessId]
    );

    invalidateCacheForBiz(businessId);
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
    // n !== 0 — acepta negativos (artículos manuales)
    return Number.isFinite(n) && n !== 0 ? n : null;
  }

  // si viene como string numérica
  if (typeof a === 'string') {
    const n = Number(a);
    return Number.isFinite(n) && n !== 0 ? n : null;
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
    return Number.isFinite(n) && n !== 0 ? n : null;
  }

  return null;
}

exports.createOrMoveAgrupacion = async (req, res) => {
  let businessId = getBusinessId(req);
  const nombre = String(req.body?.nombre || '').trim();
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number)
    // n !== 0 — acepta negativos (artículos manuales)
    .filter((n) => Number.isFinite(n) && n !== 0);

  if (!Number.isFinite(businessId) || !nombre || !ids.length) {
    return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
  }

  // Guardar el negocio original ANTES de cualquier redirección
  const originalBusinessId = businessId;

  // Si el destino es "Discontinuados" y es subnegocio, redirigir al principal
  if (isDiscontinuadosName(nombre)) {
    const { rows: bizRows } = await pool.query(
      `SELECT b.created_from, b.organization_id FROM app_businesses b WHERE b.id = $1`,
      [businessId]
    );
    const biz = bizRows[0];
    if (biz?.created_from === 'from_group' && biz?.organization_id) {
      const { rows: orgBiz } = await pool.query(
        `SELECT id FROM app_businesses WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [biz.organization_id]
      );
      if (orgBiz[0]?.id) {
        businessId = orgBiz[0].id;
        console.log(`[createOrMoveAgrupacion] Redirigiendo Discontinuados al negocio principal ${businessId}`);
      }
    }
  }

  // Sin Agrupación también es global — vive en el principal igual que Discontinuados
  if (isTodoName(nombre)) {
    const { rows: bizRows } = await pool.query(
      `SELECT created_from, organization_id FROM app_businesses WHERE id = $1`,
      [businessId]
    );
    const biz = bizRows[0];
    if (biz?.created_from === 'from_group' && biz?.organization_id) {
      const { rows: orgBiz } = await pool.query(
        `SELECT id FROM app_businesses WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [biz.organization_id]
      );
      if (orgBiz[0]?.id) {
        console.log(`[createOrMoveAgrupacion] Redirigiendo Sin Agrupación de subnegocio ${originalBusinessId} al principal ${orgBiz[0].id}`);
        businessId = orgBiz[0].id;
      }
    }
  }

  const idsSet = new Set(ids);

  let nombreFinal = nombre;
  if (isTodoName(nombre)) nombreFinal = TODO_NAME_LEGACY;
  if (isDiscontinuadosName(nombre)) nombreFinal = DISC_NAME;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) crear o encontrar la agrupación destino en el negocio principal
    let destRow;
    {
      const r = await client.query(
        `SELECT id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos
           FROM agrupaciones
          WHERE business_id=$1 AND (
            nombre=$2
            OR (nombre=$3 AND $4)
          )
          ORDER BY id ASC
          LIMIT 1
          FOR UPDATE`,
        [businessId, nombreFinal, TODO_NAME_INITIAL, isTodoName(nombre)]
      );

      if (r.rows.length) {
        destRow = r.rows[0];
      } else {
        const r2 = await client.query(
          `INSERT INTO agrupaciones (business_id, nombre, articulos)
           VALUES ($1, $2, '[]'::jsonb)
           RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`,
          [businessId, nombreFinal]
        );
        destRow = r2.rows[0];
      }
    }

    const destId = Number(destRow.id);

    // 2) bloquear todas las agrupaciones del negocio destino (principal)
    const { rows: groups } = await client.query(
      `SELECT id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos
         FROM agrupaciones
        WHERE business_id=$1
        FOR UPDATE`,
      [businessId]
    );

    // 3) quitar ids de todas las agrupaciones del principal
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
        // Limpiar también app_articles_ids (columna legacy)
        await client.query(
          `UPDATE agrupaciones
              SET app_articles_ids = (
                SELECT jsonb_agg(elem)
                FROM jsonb_array_elements(COALESCE(app_articles_ids, '[]'::jsonb)) AS elem
                WHERE elem::int NOT IN (SELECT unnest($1::int[]))
              )
            WHERE id = $2 AND business_id = $3
              AND app_articles_ids IS NOT NULL`,
          [ids, gid, businessId]
        );
      }
    }

    // 3b) si se redirigió desde un subnegocio, limpiar también sus agrupaciones
    if (Number(originalBusinessId) !== Number(businessId)) {
      const { rows: subGroups } = await client.query(
        `SELECT id, COALESCE(articulos, '[]'::jsonb) AS articulos
           FROM agrupaciones
          WHERE business_id=$1
          FOR UPDATE`,
        [originalBusinessId]
      );
      for (const g of subGroups) {
        const list = parseJsonArrayLoose(g.articulos);
        const filtered = list.filter((a) => {
          const aid = extractArticuloId(a);
          return !(aid != null && idsSet.has(aid));
        });
        if (filtered.length !== list.length) {
          await client.query(
            `UPDATE agrupaciones SET articulos=$1::jsonb WHERE id=$2 AND business_id=$3`,
            [JSON.stringify(filtered), Number(g.id), originalBusinessId]
          );
          // Limpiar también app_articles_ids (columna legacy)
          await client.query(
            `UPDATE agrupaciones
                SET app_articles_ids = (
                  SELECT jsonb_agg(elem)
                  FROM jsonb_array_elements(COALESCE(app_articles_ids, '[]'::jsonb)) AS elem
                  WHERE elem::int NOT IN (SELECT unnest($1::int[]))
                )
              WHERE id = $2 AND business_id = $3
                AND app_articles_ids IS NOT NULL`,
            [ids, Number(g.id), originalBusinessId]
          );
        }
      }
    }

    // 4) agregar ids (sin duplicar) a la agrupación destino
    let moved = 0;
    {
      const list = parseJsonArrayLoose(destRow.articulos);
      const seen = new Set(list.map(extractArticuloId).filter((n) => n != null));

      const toAdd = [];
      for (const id of ids) {
        if (!seen.has(id)) {
          toAdd.push({ id });
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
    invalidateCacheForBiz(businessId);
    if (Number(originalBusinessId) !== Number(businessId)) invalidateCacheForBiz(originalBusinessId);
    return res.json({ ok: true, id: destId, nombre: nombreFinal, moved });
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
      // Intentar primero con la versión legacy (con tilde) para consistencia con negocios existentes
      // Si tampoco existe, crear con el nombre inicial (sin tilde)
      const { rows: legacyRows } = await pool.query(
        `INSERT INTO agrupaciones (business_id, nombre, articulos)
         VALUES ($1, $2, '[]'::jsonb)
         ON CONFLICT (business_id, nombre) DO UPDATE SET updated_at = NOW()
         RETURNING id, nombre`,
        [businessId, TODO_NAME_LEGACY]
      );
      todoRow = legacyRows[0] || null;

      if (!todoRow) {
        const { rows } = await pool.query(
          `INSERT INTO agrupaciones (business_id, nombre, articulos)
           VALUES ($1, $2, '[]'::jsonb)
           ON CONFLICT (business_id, nombre) DO UPDATE SET updated_at = NOW()
           RETURNING id, nombre`,
          [businessId, TODO_NAME_INITIAL]
        );
        todoRow = rows[0] || null;
      }

      if (!todoRow) {
        // último recurso: buscar cualquier variante
        todoRow = (await pool.query(
          `SELECT id, nombre FROM agrupaciones WHERE business_id=$1 AND (nombre=$2 OR nombre=$3) LIMIT 1`,
          [businessId, TODO_NAME_LEGACY, TODO_NAME_INITIAL]
        )).rows[0];
      }
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
        } catch (_) { }
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

    // subrubro destino opcional: si viene, ademÃ¡s de mover reescribe el rubro (UI) en las 3 capas
  const nuevoSubrubro =
    typeof req.body?.subrubro === 'string' && req.body.subrubro.trim()
      ? req.body.subrubro.trim()
      : null;
  // fromId === toId sigue siendo vÃ¡lido si solo se cambia el rubro dentro de la misma agrupaciÃ³n
  if (fromId === toId && !nuevoSubrubro) return res.json({ ok: true, moved: 0 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Buscar cada grupo por su propio business_id (Discontinuados puede vivir en el principal)
    const { rows: nameRows } = await client.query(
      `SELECT id, nombre, business_id FROM agrupaciones WHERE id = ANY($1::int[])`,
      [[fromId, toId]]
    );
    const fromMeta = nameRows.find((r) => Number(r.id) === fromId);
    const toMeta = nameRows.find((r) => Number(r.id) === toId);

    console.log('[moveItems DEBUG]', {
      businessId,
      fromId,
      toId,
      idsRecibidos: ids,
      fromMeta,
      toMeta,
    });

    if (!fromMeta || !toMeta) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Agrupación/es no encontrada/s' });
    }

    // Para Discontinuados en subnegocio, redirigir al business_id del principal
    const resolveDiscBizId = async (agNombre, reqBizId) => {
      if (!isDiscontinuadosName(agNombre)) return reqBizId;
      const { rows: bRows } = await client.query(
        `SELECT created_from, organization_id FROM app_businesses WHERE id = $1`, [reqBizId]
      );
      const biz = bRows[0];
      if (biz?.created_from === 'from_group' && biz?.organization_id) {
        const { rows: oRows } = await client.query(
          `SELECT id FROM app_businesses WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1`,
          [biz.organization_id]
        );
        if (oRows[0]?.id) return oRows[0].id;
      }
      return reqBizId;
    };

    const fromBizId = await resolveDiscBizId(fromMeta.nombre, Number(fromMeta.business_id));
    const toBizId = await resolveDiscBizId(toMeta.nombre, Number(toMeta.business_id));

    const { rows: fromRows } = await client.query(
      `SELECT id, articulos FROM agrupaciones WHERE id=$1 AND business_id=$2 FOR UPDATE`,
      [fromId, fromBizId]
    );
    const { rows: toRows } = await client.query(
      `SELECT id, articulos FROM agrupaciones WHERE id=$1 AND business_id=$2 FOR UPDATE`,
      [toId, toBizId]
    );

    const fromRow = fromRows[0] || null;
    const toRow = toRows[0] || null;

    if (!fromRow || !toRow) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Agrupación/es no encontrada/s' });
    }

    const fromList = parseJsonArrayLoose(fromRow.articulos);
    const toList = parseJsonArrayLoose(toRow.articulos);

    const idsSet = new Set(ids);
    const moving = fromList.filter((a) => idsSet.has(Number(a.id)));

    console.log('[moveItems MATCH]', {
      fromListLength: fromList.length,
      fromListSample: fromList.slice(0, 3).map(a => ({ id: a.id, tipo: typeof a.id })),
      idsSetSample: [...idsSet].slice(0, 3),
      idsSetTipos: [...idsSet].slice(0, 3).map(x => typeof x),
      movingLength: moving.length,
    });

    if (!moving.length) {
      await client.query('COMMIT');
      return res.json({ ok: true, moved: 0 });
    }

    const seen = new Set(toList.map((x) => Number(x.id)));
    const toMerged = [...toList];

        for (const it of moving) {
      const id = Number(it.id);
      if (!seen.has(id)) {
        // si viene subrubro nuevo, se escribe en la copia del jsonb destino
        toMerged.push(nuevoSubrubro ? { ...it, id, subrubro: nuevoSubrubro } : { ...it, id });
        seen.add(id);
      }
    }

    const fromFiltered = fromList.filter((a) => !idsSet.has(Number(a.id)));

    await client.query(
      `UPDATE agrupaciones SET articulos = $1::jsonb WHERE id = $2 AND business_id = $3`,
      [JSON.stringify(fromFiltered), fromId, fromBizId]
    );

    // Limpiar también app_articles_ids (columna legacy) si existe
    await client.query(
      `UPDATE agrupaciones
          SET app_articles_ids = (
            SELECT jsonb_agg(elem)
            FROM jsonb_array_elements(COALESCE(app_articles_ids, '[]'::jsonb)) AS elem
            WHERE elem::int NOT IN (SELECT unnest($1::int[]))
          )
        WHERE id = $2 AND business_id = $3
          AND app_articles_ids IS NOT NULL`,
      [ids, fromId, fromBizId]
    );

        await client.query(
      `UPDATE agrupaciones SET articulos = $1::jsonb WHERE id = $2 AND business_id = $3`,
      [JSON.stringify(toMerged), toId, toBizId]
    );
    // Si viene subrubro nuevo: reescribir fuente de verdad + copia desnormalizada
    if (nuevoSubrubro) {
      // maxi_articles.subrubro = "Rubro" UI (fuente de verdad, respetada por el sync)
      await client.query(
        `UPDATE maxi_articles SET subrubro = $1 WHERE id = ANY($2::int[])`,
        [nuevoSubrubro, ids]
      );
      // agrupacion_articulos.subrubro (copia desnormalizada) para el destino
      await client.query(
        `UPDATE agrupacion_articulos
            SET subrubro = $1
          WHERE agrupacion_id = $2 AND articulo_id = ANY($3::int[])`,
        [nuevoSubrubro, toId, ids]
      );
    }
    await client.query('COMMIT');

    // Invalidar caché de artículos para ambos negocios involucrados
    invalidateCacheForBiz(fromBizId);
    if (toBizId !== fromBizId) invalidateCacheForBiz(toBizId);
    invalidateCacheForBiz(businessId);

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
// ============================================================================
// GET /businesses/:businessId/agrupaciones/articulo/:articuloId/origen
// Devuelve el grupo y negocio de origen real de un artículo
// (busca en todos los negocios de la misma organización, excluye Discontinuados/Todo/SinAgrupación)
// Soporta tanto el JSONB `articulos` (negocios nuevos) como `app_articles_ids` (negocios legacy 44/45)
// ============================================================================
exports.getArticuloOrigen = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    const articuloId = Number(req.params.articuloId);

    if (!Number.isFinite(businessId) || !Number.isFinite(articuloId)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Obtener la organización del negocio actual
    const { rows: bizRows } = await pool.query(
      `SELECT organization_id, created_from FROM app_businesses WHERE id = $1`,
      [businessId]
    );
    const biz = bizRows[0];
    if (!biz) return res.status(404).json({ ok: false, error: 'Negocio no encontrado' });

    // Buscar en todos los negocios de la organización (o solo este si no tiene org)
    let bizIds = [businessId];
    if (biz.organization_id) {
      const { rows: orgBizRows } = await pool.query(
        `SELECT id FROM app_businesses WHERE organization_id = $1`,
        [biz.organization_id]
      );
      bizIds = orgBizRows.map(r => Number(r.id));
    }

    const excludeNames = `
      AND a.nombre NOT ILIKE 'Discontinuados'
      AND a.nombre NOT ILIKE 'Descontinuados'
      AND a.nombre NOT ILIKE 'Todo'
      AND a.nombre NOT ILIKE 'Sin Agrupaci_n'
      AND a.nombre NOT ILIKE 'Sin Agrupar'
      AND a.nombre NOT ILIKE 'Sin Grupo'
      AND (a.is_temporary IS NULL OR a.is_temporary = false)
    `;

    // 1. Buscar en JSONB `articulos` usando jsonb_array_elements (exacto, sin falsos positivos)
    const { rows: agRows } = await pool.query(
      `SELECT DISTINCT a.id, a.nombre, a.business_id, b.name AS business_nombre
         FROM agrupaciones a
         JOIN app_businesses b ON b.id = a.business_id,
         jsonb_array_elements(COALESCE(a.articulos, '[]'::jsonb)) AS art
        WHERE a.business_id = ANY($1::int[])
          AND (art->>'id')::int = $2
          ${excludeNames}`,
      [bizIds, articuloId]
    );

    let allRows = agRows;

    // 2. Si no encontró nada, buscar en `app_articles_ids` (negocios legacy como 44/45)
    if (!allRows.length) {
      const { rows: legacyRows } = await pool.query(
        `SELECT a.id, a.nombre, a.business_id, b.name AS business_nombre
       FROM agrupaciones a
       JOIN app_businesses b ON b.id = a.business_id
      WHERE a.business_id = ANY($1::int[])
        AND a.app_articles_ids IS NOT NULL
        AND a.app_articles_ids @> to_jsonb($2::int)
        ${excludeNames}`,
        [bizIds, articuloId]
      );
      allRows = legacyRows;
    }

    if (!allRows.length) {
      return res.json({ ok: true, origen: null });
    }

    // Priorizar: 1) negocio que hizo el request, 2) primer resultado
    const preferred =
      allRows.find(r => Number(r.business_id) === businessId) || allRows[0];

    return res.json({
      ok: true,
      origen: {
        groupId: Number(preferred.id),
        groupName: preferred.nombre,
        bizId: Number(preferred.business_id),
        bizName: preferred.business_nombre,
      },
    });
  } catch (e) {
    console.error('getArticuloOrigen error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ============================================================================
// POST /businesses/:businessId/agrupaciones/articulos/origenes
// Body: { ids: number[] }
// Devuelve el origen de cada artículo: { [articuloId]: { groupId, groupName, bizId, bizName } }
//
// Estrategia (en orden de prioridad):
//   1. Leer metadata fromGroupId/fromBizId guardada en el JSONB de Discontinuados
//      (se guarda al momento de discontinuar, es la fuente más confiable)
//   2. Buscar en qué agrupación real está el artículo actualmente
//      (fallback para artículos discontinuados antes del fix)
//   3. Buscar en app_articles_ids (negocios legacy)
// ============================================================================
exports.getArticulosOrigenes = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map(Number).filter(Number.isFinite);

    if (!Number.isFinite(businessId) || !ids.length) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Obtener todos los negocios de la organización
    const { rows: bizRows } = await pool.query(
      `SELECT organization_id FROM app_businesses WHERE id = $1`, [businessId]
    );
    const orgId = bizRows[0]?.organization_id;

    let bizIds = [businessId];
    if (orgId) {
      const { rows: orgBizRows } = await pool.query(
        `SELECT id FROM app_businesses WHERE organization_id = $1`, [orgId]
      );
      bizIds = orgBizRows.map(r => Number(r.id));
    }

    const idsSet = new Set(ids);
    const origenes = {};

    // ── PASO 1: Leer metadata de origen desde el JSONB de Discontinuados ──
    // Cuando discontinuamos guardamos { id, fromGroupId, fromGroupName, fromBizId }
    const { rows: discRows } = await pool.query(
      `SELECT a.id AS agrup_id, a.business_id,
              COALESCE(a.articulos, '[]'::jsonb) AS articulos
         FROM agrupaciones a
        WHERE a.business_id = ANY($1::int[])
          AND (a.nombre ILIKE 'Discontinuados' OR a.nombre ILIKE 'Descontinuados')`,
      [bizIds]
    );

    // ── 1a) Recolectar todos los fromBizId/fromGroupId referenciados ──
    const refBizIds = new Set();
    const refGroupIds = new Set();
    for (const disc of discRows) {
      const arts = parseJsonArrayLoose(disc.articulos);
      for (const a of arts) {
        const artId = Number(a?.id);
        if (!idsSet.has(artId)) continue;
        if (a.fromBizId) refBizIds.add(Number(a.fromBizId));
        if (a.fromGroupId) refGroupIds.add(Number(a.fromGroupId));
      }
    }

    // ── 1b) Validar cuáles siguen existiendo ──
    const aliveBizIds = new Set();
    const aliveGroupIds = new Set();
    const bizNamesById = new Map();

    if (refBizIds.size) {
      const { rows: liveBizRows } = await pool.query(
        `SELECT id, name FROM app_businesses WHERE id = ANY($1::int[])`,
        [Array.from(refBizIds)]
      );
      for (const r of liveBizRows) {
        aliveBizIds.add(Number(r.id));
        bizNamesById.set(Number(r.id), r.name);
      }
    }
    if (refGroupIds.size) {
      const { rows: liveGroupRows } = await pool.query(
        `SELECT id FROM agrupaciones WHERE id = ANY($1::int[])`,
        [Array.from(refGroupIds)]
      );
      for (const r of liveGroupRows) aliveGroupIds.add(Number(r.id));
    }

    // ── 1c) Asignar origen solo si negocio Y grupo siguen vivos ──
    for (const disc of discRows) {
      const arts = parseJsonArrayLoose(disc.articulos);
      for (const a of arts) {
        const artId = Number(a?.id);
        if (!idsSet.has(artId)) continue;
        if (origenes[artId]) continue;

        if (!a.fromGroupId || !a.fromBizId) continue;

        const fromBizId = Number(a.fromBizId);
        const fromGroupId = Number(a.fromGroupId);

        // Si el negocio o el grupo ya no existen → tratar como sin origen
        // (caerá al paso 2 o se quedará en Sin Agrupación)
        if (!aliveBizIds.has(fromBizId) || !aliveGroupIds.has(fromGroupId)) {
          console.log(`[getArticulosOrigenes] Artículo ${artId} con origen huérfano (biz=${fromBizId}, grp=${fromGroupId}) — ignorado`);
          continue;
        }

        origenes[artId] = {
          groupId: fromGroupId,
          groupName: a.fromGroupName || `Agrupación #${fromGroupId}`,
          bizId: fromBizId,
          bizName: bizNamesById.get(fromBizId) || `Negocio #${fromBizId}`,
        };
      }
    }

    // ── PASO 2: Fallback — buscar en agrupaciones reales (artículos sin metadata) ──
    // Para artículos discontinuados antes del fix que no tienen fromGroupId guardado
    const missingIds = ids.filter(id => !origenes[id]);

    if (missingIds.length > 0) {
      const { rows: agRows } = await pool.query(
        `SELECT a.id, a.nombre, a.business_id, b.name AS business_nombre,
                COALESCE(a.articulos, '[]'::jsonb) AS articulos,
                a.app_articles_ids
           FROM agrupaciones a
           JOIN app_businesses b ON b.id = a.business_id
          WHERE a.business_id = ANY($1::int[])
            AND a.nombre NOT ILIKE 'Discontinuados'
            AND a.nombre NOT ILIKE 'Descontinuados'
            AND a.nombre NOT ILIKE 'Todo'
            AND a.nombre NOT ILIKE 'Sin Agrupaci_n'
            AND a.nombre NOT ILIKE 'Sin Agrupar'
            AND a.nombre NOT ILIKE 'Sin Grupo'
            AND (a.is_temporary IS NULL OR a.is_temporary = false)`,
        [bizIds]
      );

      const missingSet = new Set(missingIds);

      for (const ag of agRows) {
        // Buscar en JSONB articulos
        const arts = parseJsonArrayLoose(ag.articulos);
        for (const art of arts) {
          const artId = Number(art?.id);
          if (!missingSet.has(artId)) continue;
          if (origenes[artId]) continue;
          origenes[artId] = {
            groupId: Number(ag.id),
            groupName: ag.nombre,
            bizId: Number(ag.business_id),
            bizName: ag.business_nombre,
          };
        }

        // Buscar en app_articles_ids (legacy)
        const legacyIds = Array.isArray(ag.app_articles_ids)
          ? ag.app_articles_ids.map(Number)
          : (typeof ag.app_articles_ids === 'string'
            ? JSON.parse(ag.app_articles_ids || '[]').map(Number)
            : []);
        for (const artId of legacyIds) {
          if (!missingSet.has(artId)) continue;
          if (origenes[artId]) continue;
          origenes[artId] = {
            groupId: Number(ag.id),
            groupName: ag.nombre,
            bizId: Number(ag.business_id),
            bizName: ag.business_nombre,
          };
        }
      }
    }

    return res.json({ ok: true, origenes });
  } catch (e) {
    console.error('getArticulosOrigenes error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ============================================================================
// DELETE /businesses/:businessId/agrupaciones/:id/articulos
// Body: { ids: number[] }
// Elimina múltiples artículos de una agrupación en un solo request (bulk).
// ============================================================================
exports.eliminarArticulosDeAgrupacionBulk = async (req, res) => {
  try {
    let businessId = Number(req.params.businessId);
    if (!Number.isFinite(businessId)) {
      businessId = getBusinessId(req);
    }

    const id = Number(req.params.id ?? req.params.agrupacionId);
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map(Number).filter(Number.isFinite);

    if (!Number.isFinite(businessId) || !Number.isFinite(id) || !ids.length) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // Redirigir al negocio principal si la agrupación es Discontinuados y venimos de subnegocio
    {
      const { rows: agRows } = await pool.query(
        `SELECT nombre FROM agrupaciones WHERE id = $1`, [id]
      );
      const agNombre = agRows[0]?.nombre ?? '';
      if (isDiscontinuadosName(agNombre)) {
        const { rows: bizRows } = await pool.query(
          `SELECT created_from, organization_id FROM app_businesses WHERE id = $1`, [businessId]
        );
        const biz = bizRows[0];
        if (biz?.created_from === 'from_group' && biz?.organization_id) {
          const { rows: orgBiz } = await pool.query(
            `SELECT id FROM app_businesses WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1`,
            [biz.organization_id]
          );
          if (orgBiz[0]?.id) businessId = orgBiz[0].id;
        }
      }
    }

    const { rows: r0 } = await pool.query(
      `SELECT articulos FROM agrupaciones WHERE id=$1 AND business_id=$2`,
      [id, businessId]
    );

    if (!r0.length) {
      return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });
    }

    const idsSet = new Set(ids);
    const base = parseJsonArrayLoose(r0[0].articulos);
    const filtered = base.filter(a => !idsSet.has(Number(a.id)));
    const removed = base.length - filtered.length;

    const { rows } = await pool.query(
      `UPDATE agrupaciones
          SET articulos = $1::jsonb, updated_at = NOW()
        WHERE id = $2 AND business_id = $3
        RETURNING id, nombre, COALESCE(articulos, '[]'::jsonb) AS articulos`,
      [JSON.stringify(filtered), id, businessId]
    );

    // Limpiar también app_articles_ids (columna legacy)
    await pool.query(
      `UPDATE agrupaciones
          SET app_articles_ids = (
            SELECT jsonb_agg(elem)
            FROM jsonb_array_elements(COALESCE(app_articles_ids, '[]'::jsonb)) AS elem
            WHERE elem::int NOT IN (SELECT unnest($1::int[]))
          )
        WHERE id = $2 AND business_id = $3
          AND app_articles_ids IS NOT NULL`,
      [Array.from(idsSet), id, businessId]
    );

    invalidateCacheForBiz(businessId);
    return res.json({ ok: true, removed, remaining: filtered.length, data: rows[0] });
  } catch (e) {
    console.error('eliminarArticulosDeAgrupacionBulk error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /businesses/:businessId/agrupaciones/move-cross-biz
// Body: { articleId, toGroupId, toBizId }
// Mueve un artículo entre negocios:
// 1. Agrega al grupo destino
// 2. Quita de TODAS las agrupaciones de la org (excepto destino)
exports.moveCrossBiz = async (req, res) => {
  const businessId = getBusinessId(req);
  const { articleId, toGroupId, toBizId } = req.body || {};

  const artId = Number(articleId);
  const toGrpId = Number(toGroupId);
  const toBizIdNum = Number(toBizId);

  if (!artId || !toGrpId || !toBizIdNum) {
    return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Obtener todos los negocios de la org
    const { rows: bizRows } = await client.query(
      `SELECT organization_id FROM app_businesses WHERE id = $1`, [businessId]
    );
    const orgId = bizRows[0]?.organization_id;

    let bizIds = [businessId];
    if (orgId) {
      const { rows: orgBizRows } = await client.query(
        `SELECT id FROM app_businesses WHERE organization_id = $1`, [orgId]
      );
      bizIds = orgBizRows.map(r => Number(r.id));
    }

    // 2. Quitar artículo de TODAS las agrupaciones de la org (excepto el grupo destino)
    const { rows: agrupRows } = await client.query(
      `SELECT id, articulos, business_id FROM agrupaciones
       WHERE business_id = ANY($1::int[])
         AND articulos @> $2::jsonb
         AND id != $3`,
      [bizIds, JSON.stringify([{ id: artId }]), toGrpId]
    );

    for (const ag of agrupRows) {
      const arts = parseJsonArrayLoose(ag.articulos);
      const filtered = arts.filter(a => Number(a.id) !== artId);
      await client.query(
        `UPDATE agrupaciones SET articulos = $1::jsonb WHERE id = $2 AND business_id = $3`,
        [JSON.stringify(filtered), ag.id, ag.business_id]
      );
      invalidateCacheForBiz(ag.business_id);
    }

    // 3. Agregar al grupo destino
    const { rows: toRows } = await client.query(
      `SELECT id, articulos FROM agrupaciones WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [toGrpId, toBizIdNum]
    );
    if (!toRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Grupo destino no encontrado' });
    }

    const toList = parseJsonArrayLoose(toRows[0].articulos);
    if (!toList.some(a => Number(a.id) === artId)) {
      toList.push({ id: artId });
      await client.query(
        `UPDATE agrupaciones SET articulos = $1::jsonb WHERE id = $2 AND business_id = $3`,
        [JSON.stringify(toList), toGrpId, toBizIdNum]
      );
    }

    await client.query('COMMIT');
    invalidateCacheForBiz(toBizIdNum);
    return res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('moveCrossBiz error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

// ============================================================================
// POST /businesses/:businessId/agrupaciones/move-cross-biz
// Body: { articleIds: number[], toGroupId: number, toBizId: number }
//
// Mueve uno o más artículos entre negocios de la misma organización:
//   1. Los quita de TODAS las agrupaciones de la org (excepto el grupo destino)
//   2. Los agrega al grupo destino
//
// Esto evita duplicados cuando un artículo quedó en múltiples negocios
// por movimientos anteriores que no limpiaron bien.
// ============================================================================
exports.moveCrossBiz = async (req, res) => {
  const businessId = getBusinessId(req);
  const { articleIds, toGroupId, toBizId } = req.body || {};

  const artIds = (Array.isArray(articleIds) ? articleIds : [articleIds])
    .map(Number)
    .filter(Number.isFinite);
  const toGrpId = Number(toGroupId);
  const toBizIdNum = Number(toBizId);

  if (!artIds.length || !Number.isFinite(toGrpId) || !Number.isFinite(toBizIdNum)) {
    return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Obtener todos los negocios de la organización
    const { rows: bizRows } = await client.query(
      `SELECT organization_id FROM app_businesses WHERE id = $1`,
      [businessId]
    );
    const orgId = bizRows[0]?.organization_id;

    let bizIds = [businessId];
    if (orgId) {
      const { rows: orgBizRows } = await client.query(
        `SELECT id FROM app_businesses WHERE organization_id = $1`,
        [orgId]
      );
      bizIds = orgBizRows.map(r => Number(r.id));
    }

    // 2. Traer todas las agrupaciones de la org excepto el grupo destino
    const { rows: agrupRows } = await client.query(
      `SELECT id, articulos, app_articles_ids, business_id
         FROM agrupaciones
        WHERE business_id = ANY($1::int[])
          AND id != $2`,
      [bizIds, toGrpId]
    );

    const artIdsSet = new Set(artIds);

    // 3. Quitar los artículos de cada agrupación que los contenga
    for (const ag of agrupRows) {
      const arts = parseJsonArrayLoose(ag.articulos);
      const tieneAlguno = arts.some(a => artIdsSet.has(Number(a.id)));

      // Verificar también en app_articles_ids (legacy)
      const appIds = Array.isArray(ag.app_articles_ids) ? ag.app_articles_ids
        : (typeof ag.app_articles_ids === 'string'
          ? JSON.parse(ag.app_articles_ids || '[]')
          : []);
      const tieneEnLegacy = appIds.some(id => artIdsSet.has(Number(id)));

      if (!tieneAlguno && !tieneEnLegacy) continue;

      if (tieneAlguno) {
        const filtered = arts.filter(a => !artIdsSet.has(Number(a.id)));
        await client.query(
          `UPDATE agrupaciones SET articulos = $1::jsonb WHERE id = $2 AND business_id = $3`,
          [JSON.stringify(filtered), ag.id, ag.business_id]
        );
      }

      if (tieneEnLegacy) {
        await client.query(
          `UPDATE agrupaciones
              SET app_articles_ids = (
                SELECT jsonb_agg(elem)
                FROM jsonb_array_elements(COALESCE(app_articles_ids, '[]'::jsonb)) AS elem
                WHERE elem::int NOT IN (SELECT unnest($1::int[]))
              )
            WHERE id = $2 AND business_id = $3
              AND app_articles_ids IS NOT NULL`,
          [artIds, ag.id, ag.business_id]
        );
      }

      invalidateCacheForBiz(ag.business_id);
    }

    // 4. Agregar al grupo destino (sin duplicar)
    const { rows: toRows } = await client.query(
      `SELECT id, articulos FROM agrupaciones
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [toGrpId, toBizIdNum]
    );

    if (!toRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Grupo destino no encontrado' });
    }

    const toList = parseJsonArrayLoose(toRows[0].articulos);
    const existingIds = new Set(toList.map(a => Number(a.id)));
    let added = 0;

    for (const artId of artIds) {
      if (!existingIds.has(artId)) {
        toList.push({ id: artId });
        existingIds.add(artId);
        added++;
      }
    }

    await client.query(
      `UPDATE agrupaciones SET articulos = $1::jsonb WHERE id = $2 AND business_id = $3`,
      [JSON.stringify(toList), toGrpId, toBizIdNum]
    );

    await client.query('COMMIT');
    invalidateCacheForBiz(toBizIdNum);
    if (toBizIdNum !== businessId) invalidateCacheForBiz(businessId);

    console.log(`[moveCrossBiz] ${artIds.length} artículo(s) movidos a grupo ${toGrpId} (negocio ${toBizIdNum}), added=${added}`);

    return res.json({ ok: true, moved: artIds.length, added });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('moveCrossBiz error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};