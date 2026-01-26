// controllers/insumosController.js
const pool = require('../config/db');
const { parse } = require('csv-parse/sync');
const getBusinessId = require('../utils/getBusinessId');
const {
  fetchMaxiInsumos,
  normalizarInsumosMaxi,
  fetchMaxiInsumosRubros,
  normalizarInsumosRubros,
} = require('../services/maxiSuppliesService');

const { upsertFromMaxi } = require('../repos/insumosRepo');
const insumosRubrosRepo = require('../repos/insumosRubrosRepo');
const { autoAssignNewInsumos } = require('../services/autoAssignNewInsumos');
const { notifyAutoAssignInsumos } = require('../services/notificationService'); 

// ===================== HELPERS COMPARTIDOS ====================
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

const ALLOWED_ORDER_BY = ['nombre', 'codigo_maxi', 'rubro', 'unidad_med', 'precio_ref', 'created_at'];

function sendError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

// ✅ executor puede ser pool o client (para transacciones)
async function assertGroup(executor, bizId, groupId) {
  const r = await executor.query(
    'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2',
    [groupId, bizId]
  );
  return (r.rowCount || 0) > 0;
}

if (process.env.NODE_ENV !== 'production') {
  console.log('💡 insumosController.js cargado (UNIFICADO)');
}

// ===================== INSUMOS: LISTAR / CRUD BÁSICO =====================
exports.listar = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search = '',
      rubro,
      unidadMed,
      origen,
      orderBy = 'nombre',
      order = 'ASC',
      elaborados,
      estado,
      sinAgrupacion,
    } = req.query;

    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const where = [];
    const params = [];

    params.push(businessId);
    where.push(`business_id = $${params.length}`);

    if (search) {
      params.push(`%${search}%`, `%${search}%`);
      where.push(
        `(nombre ILIKE $${params.length - 1} OR codigo_maxi ILIKE $${params.length})`
      );
    }

    if (rubro) {
      params.push(String(rubro));
      where.push(`rubro = $${params.length}`);
    }

    if (unidadMed) {
      params.push(unidadMed);
      where.push(`unidad_med = $${params.length}`);
    }

    if (origen) {
      params.push(origen);
      where.push(`origen = $${params.length}`);
    }

    if (estado && estado !== 'all') {
      params.push(estado);
      where.push(`estado = $${params.length}`);
    }

    if (sinAgrupacion === 'true') {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM insumo_group_items gi
          JOIN insumo_groups g ON g.id = gi.group_id
          WHERE gi.insumo_id = insumos.id
            AND g.business_id = insumos.business_id
        )
      `);
    }

    if (elaborados === 'true') {
      where.push(`
        EXISTS (
          SELECT 1
          FROM insumo_rubros ir
          WHERE ir.business_id = insumos.business_id
            AND ir.codigo::text = insumos.rubro
            AND ir.es_elaborador = true
        )
      `);
    }

    if (elaborados === 'false') {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM insumo_rubros ir
          WHERE ir.business_id = insumos.business_id
            AND ir.codigo::text = insumos.rubro
            AND ir.es_elaborador = true
        )
      `);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const hardLimit = Math.min(Math.max(Number(limit), 1), 10000);
    const offset = (Number(page) - 1) * hardLimit;

    const safeOrderBy = ALLOWED_ORDER_BY.includes(orderBy) ? orderBy : 'nombre';
    const safeOrder = order === 'DESC' ? 'DESC' : 'ASC';

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `
        SELECT *
        FROM insumos
        ${whereSql}
        ORDER BY ${safeOrderBy} ${safeOrder}
        LIMIT $${params.length + 1}
        OFFSET $${params.length + 2}
      `,
        [...params, hardLimit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM insumos ${whereSql}`,
        params
      ),
    ]);

    res.json({
      ok: true,
      data: dataRes.rows,
      pagination: {
        page: Number(page),
        limit: hardLimit,
        total: countRes.rows[0].total,
      },
    });
  } catch (e) {
    console.error('listar error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.crearManual = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const b = req.body || {};
    if (!b.nombre?.trim()) {
      return res.status(400).json({ ok: false, error: 'Nombre requerido' });
    }

    const estado = b.estado === 'discontinuado' ? 'discontinuado' : 'activo';

    const { rows } = await pool.query(
      `
      INSERT INTO insumos
      (business_id, codigo_maxi, nombre, unidad_med, precio_ref, rubro,
       envase, vencimiento, resumen, cant_ingredientes,
       agrupacion_base, costo_ref, nota, origen, estado)
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `,
      [
        businessId,
        b.codigoMaxi ?? null,
        b.nombre.trim(),
        b.unidadMed ?? null,
        num(b.precioRef),
        b.rubro ?? null,
        b.envase ?? null,
        b.vencimiento ?? null,
        b.resumen ?? null,
        b.cantIngredientes ?? null,
        b.agrupacionBase ?? null,
        num(b.costoRef),
        b.nota ?? null,
        b.origen ?? 'manual',
        estado,
      ]
    );

    res.status(201).json({ ok: true, data: rows[0] });
  } catch (e) {
    console.error('crearManual error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.actualizar = async (req, res) => {
  try {
    const { id } = req.params;
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const b = req.body || {};
    const sets = [];
    const vals = [];

    const push = (c, v) => {
      vals.push(v);
      sets.push(`${c} = $${vals.length}`);
    };

    if (b.nombre !== undefined) push('nombre', b.nombre);
    if (b.unidadMed !== undefined) push('unidad_med', b.unidadMed);
    if (b.precioRef !== undefined) push('precio_ref', num(b.precioRef));
    if (b.rubro !== undefined) push('rubro', b.rubro);
    if (b.estado !== undefined) push('estado', b.estado);
    if (b.nota !== undefined) push('nota', b.nota);

    if (!sets.length) return res.json({ ok: true });

    vals.push(id, businessId);

    const { rows } = await pool.query(
      `
      UPDATE insumos
      SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${vals.length - 1}
        AND business_id = $${vals.length}
      RETURNING *
    `,
      vals
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (e) {
    console.error('actualizar error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.eliminar = async (req, res) => {
  try {
    const { id } = req.params;
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const r = await pool.query(
      `
      UPDATE insumos
      SET estado = 'discontinuado', updated_at = NOW()
      WHERE id = $1 AND business_id = $2
    `,
      [id, businessId]
    );

    if (!r.rowCount) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('eliminar error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

// ===================== INSUMOS: BULK (JSON/CSV) =====================
exports.bulkUpsert = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const items = Array.isArray(req.body) ? req.body : [];
    if (!items.length) {
      return res.status(400).json({ ok: false, error: 'Body debe ser un array de insumos' });
    }

    const client = await pool.connect();
    let inserted = 0, updated = 0, skipped = 0;

    try {
      await client.query('BEGIN');

      for (const it of items) {
        const codigo = it.codigoMaxi ?? it.codigo_maxi ?? it.codigo ?? null;
        if (!codigo || String(codigo).trim() === '') {
          skipped++;
          continue;
        }

        const nombre = (it.nombre ?? '').trim();
        const unidad_med = it.unidadMed ?? it.unidad_med ?? null;
        const precio_ref = it.precioRef ?? it.precio_ref ?? null;
        const rubro = it.rubro ?? null;
        const origen = it.origen ?? 'manual';
        const estado = it.estado === 'discontinuado' ? 'discontinuado' : 'activo';

        const r = await client.query(
          `INSERT INTO insumos
           (business_id, codigo_maxi, nombre, unidad_med, precio_ref, rubro, origen, estado)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (business_id, codigo_maxi) DO UPDATE SET
             nombre = EXCLUDED.nombre,
             unidad_med = EXCLUDED.unidad_med,
             precio_ref = EXCLUDED.precio_ref,
             rubro = EXCLUDED.rubro,
             origen = EXCLUDED.origen,
             estado = EXCLUDED.estado,
             updated_at = NOW()
           RETURNING (xmax = 0) AS inserted`,
          [
            businessId,
            String(codigo),
            nombre,
            unidad_med,
            precio_ref == null ? null : Number(precio_ref),
            rubro,
            origen,
            estado,
          ]
        );

        if (r.rows?.[0]?.inserted) inserted++;
        else updated++;
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return res.json({
      ok: true,
      summary: {
        inserted,
        updated,
        skipped,
        total: inserted + updated + skipped
      }
    });
  } catch (e) {
    console.error('bulkUpsert error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

exports.bulkUpsertCSV = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Subí un CSV en el campo "file"' });
    }

    const text = req.file.buffer.toString('utf8');
    const rows = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    req.body = rows.map(r => ({
      codigoMaxi: r.codigoMaxi ?? r.codigo_maxi ?? r.codigo,
      nombre: r.nombre ?? '',
      unidadMed: r.unidadMed ?? r.unidad_med ?? null,
      precioRef: r.precioRef ?? r.precio_ref ?? null,
      rubro: r.rubro ?? null,
      origen: r.origen ?? 'csv',
      estado: String(r.estado ?? r.activo ?? 'activo').toLowerCase() === 'discontinuado'
        ? 'discontinuado'
        : 'activo'
    }));

    return exports.bulkUpsert(req, res);
  } catch (e) {
    console.error('bulkUpsertCSV error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ===================== INSUMOS: MANTENIMIENTO =====================
exports.__cleanupNullInsumos = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r1 = await client.query(`
      DELETE FROM insumos
      WHERE nombre IS NULL OR TRIM(COALESCE(nombre, '')) = ''
    `);

    const r2 = await client.query(`
      UPDATE insumos
      SET nombre = NULLIF(TRIM(nombre), ''),
          unidad_med = NULLIF(TRIM(unidad_med), ''),
          updated_at = NOW()
      WHERE (nombre IS NOT NULL AND nombre <> TRIM(nombre))
         OR (unidad_med IS NOT NULL AND unidad_med <> TRIM(unidad_med))
    `);

    const r3 = await client.query(`
      DELETE FROM insumos a
      USING insumos b
      WHERE a.id > b.id
        AND a.codigo_maxi IS NOT NULL
        AND a.codigo_maxi = b.codigo_maxi
        AND a.business_id = b.business_id
    `);

    await client.query('COMMIT');

    return res.json({
      ok: true,
      removed_without_name: r1.rowCount,
      normalized: r2.rowCount,
      removed_dupes_by_code: r3.rowCount
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('__cleanupNullInsumos error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

// ===================== INSUMOS: MAXI SYNC =====================
exports.listarMaxi = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const { rows } = await pool.query(
      `SELECT *
       FROM insumos
       WHERE business_id = $1
         AND origen = 'maxi'
       ORDER BY nombre ASC`,
      [businessId]
    );

    return res.json({
      ok: true,
      business_id: businessId,
      items: rows,
    });
  } catch (e) {
    console.error('listarMaxi error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

exports.syncFromMaxi = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    const userId = req.user?.id; // igual que hiciste en artículos

    // ... tu sync actual
    const raw = await fetchMaxiInsumos({ businessId, req });
    const normItems = normalizarInsumosMaxi(raw);
    const summary = await upsertFromMaxi(businessId, normItems);

    // 🆕 auto-assign
    let auto = { assigned: 0, details: [] };
    try {
      auto = await autoAssignNewInsumos(businessId);

      if (auto.assigned > 0 && userId) {
        await notifyAutoAssignInsumos({
          businessId,
          userId,
          result: auto,
        });
      }
    } catch (e) {
      // no crítico
      console.error('[syncFromMaxi] autoAssign error:', e.message);
    }

    res.json({
      ok: true,
      ...summary,
      auto_assigned: auto.assigned,
      details: auto.details,
    });
  } catch (e) {
    console.error('syncFromMaxi error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.listarRubrosMaxi = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const items = await insumosRubrosRepo.listRubrosForBusiness(businessId);
    return res.json({ ok: true, business_id: businessId, items });
  } catch (e) {
    console.error('listarRubrosMaxi error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

exports.syncRubrosFromMaxi = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const raw = await fetchMaxiInsumosRubros({ businessId, req });
    const norm = normalizarInsumosRubros(raw);
    const summary = await insumosRubrosRepo.upsertRubrosForBusiness(businessId, norm);

    return res.json({
      ok: true,
      business_id: businessId,
      received: raw.length,
      normalized: norm.length,
      ...summary,
    });
  } catch (e) {
    console.error('syncRubrosFromMaxi error:', e);
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
};

// ===================== INSUMOS: SYNC COMPRAS (opcional) =====================
exports.syncDesdeCompras = async (req, res) => {
  if (String(process.env.ENABLE_SYNC_COMPRAS || 'false').toLowerCase() !== 'true') {
    return res.status(503).json({ ok: false, error: 'syncDesdeCompras deshabilitado' });
  }
  return res.status(501).json({ ok: false, error: 'No implementado' });
};

// ===================== GROUPS: LISTAR =====================
exports.groups_list = async (req, res) => {
  console.log('🚀🚀🚀 [UNIFICADO] groups_list called 🚀🚀🚀');
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  try {
    const { rows } = await pool.query(
      `
      SELECT 
        g.id, g.business_id, g.nombre, g.descripcion, g.es_favorita,
        g.created_at, g.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'insumo_id', gi.insumo_id,
              'id', i.id,
              'nombre', i.nombre,
              'codigo_maxi', i.codigo_maxi,
              'unidad_med', i.unidad_med
            )
          ) FILTER (WHERE gi.insumo_id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM insumo_groups g
      LEFT JOIN insumo_group_items gi ON gi.group_id = g.id
      LEFT JOIN insumos i ON i.id = gi.insumo_id
      WHERE g.business_id = $1
      GROUP BY g.id
      ORDER BY lower(trim(g.nombre))
      `,
      [bizId]
    );

    console.log('📋 [groups_list] Grupos:', rows.length);
    return res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('[groups_list] error:', err);
    return sendError(res, 500, 'Error al listar agrupaciones de insumos');
  }
};

// ===================== GROUPS: OBTENER UNO =====================
exports.groups_getOne = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  try {
    const { rows } = await pool.query(
      `
      SELECT 
        g.id, g.business_id, g.nombre, g.descripcion, g.es_favorita,
        g.created_at, g.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'insumo_id', gi.insumo_id,
              'id', i.id,
              'nombre', i.nombre
            )
          ) FILTER (WHERE gi.insumo_id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM insumo_groups g
      LEFT JOIN insumo_group_items gi ON gi.group_id = g.id
      LEFT JOIN insumos i ON i.id = gi.insumo_id
      WHERE g.business_id = $1 AND g.id = $2
      GROUP BY g.id
      `,
      [bizId, id]
    );

    if (!rows.length) return sendError(res, 404, 'not_found');
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[groups_getOne] error:', err);
    return sendError(res, 500, 'Error al obtener agrupación de insumos');
  }
};

// ===================== GROUPS: CREAR / EDITAR / BORRAR =====================
exports.groups_create = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const nombre = String(req.body.nombre || '').trim();
  const descripcion = req.body.descripcion ?? null;
  if (!nombre) return sendError(res, 400, 'El nombre es obligatorio');

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO insumo_groups (business_id, nombre, descripcion)
      VALUES ($1, $2, $3)
      RETURNING id, business_id, nombre, descripcion, es_favorita,
                created_at, updated_at
      `,
      [bizId, nombre, descripcion]
    );

    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[groups_create] error:', err);
    if (err.code === '23505') {
      return sendError(res, 409, 'Ya existe una agrupación con ese nombre');
    }
    return sendError(res, 500, 'Error al crear agrupación de insumos');
  }
};

exports.groups_update = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  const nombre = req.body.nombre != null ? String(req.body.nombre).trim() : null;
  const descripcion = req.body.descripcion ?? null;
  const esFavorita = req.body.es_favorita;

  if (!nombre && descripcion == null && esFavorita == null) {
    return sendError(res, 400, 'Nada para actualizar');
  }

  const sets = [];
  const values = [id, bizId];
  let idx = values.length;

  if (nombre != null && nombre !== '') {
    idx += 1;
    sets.push(`nombre = $${idx}`);
    values.push(nombre);
  }
  if (descripcion !== undefined) {
    idx += 1;
    sets.push(`descripcion = $${idx}`);
    values.push(descripcion);
  }
  if (esFavorita !== undefined) {
    idx += 1;
    sets.push(`es_favorita = $${idx}`);
    values.push(Boolean(esFavorita));
  }
  sets.push('updated_at = now()');

  try {
    const { rows } = await pool.query(
      `
      UPDATE insumo_groups
      SET ${sets.join(', ')}
      WHERE id = $1 AND business_id = $2
      RETURNING id, business_id, nombre, descripcion, es_favorita,
                created_at, updated_at
      `,
      values
    );

    if (!rows.length) return sendError(res, 404, 'not_found');
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[groups_update] error:', err);
    if (err.code === '23505') {
      return sendError(res, 409, 'Ya existe una agrupación con ese nombre');
    }
    return sendError(res, 500, 'Error al actualizar agrupación de insumos');
  }
};

exports.groups_remove = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  try {
    const { rowCount } = await pool.query(
      'DELETE FROM insumo_groups WHERE id = $1 AND business_id = $2',
      [id, bizId]
    );
    if (!rowCount) return sendError(res, 404, 'not_found');
    return res.json({ ok: true });
  } catch (err) {
    console.error('[groups_remove] error:', err);
    return sendError(res, 500, 'Error al eliminar la agrupación de insumos');
  }
};

// ===================== GROUPS: ITEMS =====================
exports.groups_replaceItems = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const groupId = Number(req.params.id);
  if (!Number.isFinite(groupId)) return sendError(res, 400, 'ID inválido');

  const insumoIds = (req.body.insumoIds || [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

  const client = await pool.connect();
  try {
    const ok = await assertGroup(client, bizId, groupId);
    if (!ok) return sendError(res, 404, 'not_found');

    await client.query('BEGIN');

    await client.query('DELETE FROM insumo_group_items WHERE group_id = $1', [groupId]);

    if (insumoIds.length) {
      const placeholders = insumoIds.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(', ');
      const values = insumoIds.flatMap(id => [groupId, id]);

      await client.query(
        `
        INSERT INTO insumo_group_items (group_id, insumo_id)
        VALUES ${placeholders}
        ON CONFLICT (group_id, insumo_id) DO NOTHING
        `,
        values
      );
    }

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    console.error('[groups_replaceItems] error:', err);
    await client.query('ROLLBACK').catch(() => { });
    return sendError(res, 500, 'Error al actualizar items de la agrupación');
  } finally {
    client.release();
  }
};

exports.groups_addItem = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const groupId = Number(req.params.id);
  const insumoId = Number(req.body.insumoId);

  if (!Number.isFinite(groupId) || groupId <= 0) return sendError(res, 400, 'IDs inválidos');
  if (!Number.isFinite(insumoId) || insumoId <= 0) return sendError(res, 400, 'IDs inválidos');

  try {
    const ok = await assertGroup(pool, bizId, groupId);
    if (!ok) return sendError(res, 404, 'not_found');

    await pool.query(
      `
      INSERT INTO insumo_group_items (group_id, insumo_id)
      VALUES ($1, $2)
      ON CONFLICT (group_id, insumo_id) DO NOTHING
      `,
      [groupId, insumoId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('[groups_addItem] error:', err);
    return sendError(res, 500, 'Error al agregar insumo a la agrupación');
  }
};

exports.groups_addMultiple = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const groupId = Number(req.params.id);
  const insumoIds = Array.isArray(req.body?.insumoIds)
    ? req.body.insumoIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [];

  if (!Number.isFinite(groupId) || groupId <= 0) return sendError(res, 400, 'ID inválido');
  if (!insumoIds.length) return sendError(res, 400, 'Se requiere un array de insumoIds');

  const client = await pool.connect();
  try {
    const ok = await assertGroup(client, bizId, groupId);
    if (!ok) return sendError(res, 404, 'not_found');

    await client.query('BEGIN');

    const placeholders = insumoIds.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(', ');
    const values = insumoIds.flatMap(id => [groupId, id]);

    const r = await client.query(
      `
      INSERT INTO insumo_group_items (group_id, insumo_id)
      VALUES ${placeholders}
      ON CONFLICT (group_id, insumo_id) DO NOTHING
      `,
      values
    );

    await client.query('COMMIT');
    return res.json({ ok: true, added: r.rowCount || 0 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    console.error('[groups_addMultiple] error:', err);
    return sendError(res, 500, err.message || 'Error al agregar insumos en bulk');
  } finally {
    client.release();
  }
};

exports.groups_removeItem = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const groupId = Number(req.params.id);
  const insumoId = Number(req.params.insumoId);

  if (!Number.isFinite(groupId) || groupId <= 0) return sendError(res, 400, 'ID inválido');
  if (!Number.isFinite(insumoId) || insumoId <= 0) return sendError(res, 400, 'ID inválido');

  try {
    // Validar que el grupo pertenece al negocio
    const ok = await assertGroup(pool, bizId, groupId);
    if (!ok) return sendError(res, 404, 'not_found');

    // Delete idempotente
    const r = await pool.query(
      'DELETE FROM insumo_group_items WHERE group_id = $1 AND insumo_id = $2',
      [groupId, insumoId]
    );

    console.log(`✅ [groups_removeItem] bizId=${bizId}, groupId=${groupId}, insumoId=${insumoId}, removed=${r.rowCount}`);
    return res.json({ ok: true, removed: r.rowCount || 0 });
  } catch (err) {
    console.error('[groups_removeItem] error:', err);
    return sendError(res, 500, err.message || 'Error al quitar insumo de la agrupación');
  }
};

// ===================== GROUPS: EXCLUSIONES =====================
exports.groups_getExclusions = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  try {
    const ok = await assertGroup(pool, bizId, id);
    if (!ok) return sendError(res, 404, 'not_found');

    const { rows } = await pool.query(
      `
      SELECT id, scope, ref_id
      FROM insumo_group_exclusions
      WHERE group_id = $1
      ORDER BY created_at DESC
      `,
      [id]
    );

    return res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('[groups_getExclusions] error:', err);
    return sendError(res, 500, 'Error al obtener exclusiones');
  }
};

exports.groups_addExclusions = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  const { exclusions } = req.body;
  if (!Array.isArray(exclusions) || !exclusions.length) {
    return sendError(res, 400, 'exclusions debe ser un array no vacío');
  }

  try {
    const ok = await assertGroup(pool, bizId, id);
    if (!ok) return sendError(res, 404, 'not_found');

    const values = [];
    const placeholders = [];

    exclusions.forEach((e, idx) => {
      const scope = e.scope || 'insumo';
      const refId = Number(e.ref_id);
      if (!Number.isFinite(refId)) return;

      const base = idx * 3;
      values.push(id, scope, refId);
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    });

    if (!placeholders.length) return sendError(res, 400, 'No hay exclusiones válidas para agregar');

    await pool.query(
      `
      INSERT INTO insumo_group_exclusions (group_id, scope, ref_id)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (group_id, scope, ref_id) DO NOTHING
      `,
      values
    );

    return res.json({ ok: true, count: placeholders.length });
  } catch (err) {
    console.error('[groups_addExclusions] error:', err);
    return sendError(res, 500, 'Error al agregar exclusiones');
  }
};

exports.groups_removeExclusions = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  const { ids, scope = 'insumo' } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return sendError(res, 400, 'ids debe ser un array no vacío');
  }

  try {
    const ok = await assertGroup(pool, bizId, id);
    if (!ok) return sendError(res, 404, 'not_found');

    const refIds = ids.map(Number).filter(Number.isFinite);
    if (!refIds.length) return sendError(res, 400, 'No hay IDs válidos para eliminar');

    const placeholders = refIds.map((_, idx) => `$${idx + 3}`).join(', ');

    const { rowCount } = await pool.query(
      `
      DELETE FROM insumo_group_exclusions
      WHERE group_id = $1
        AND scope = $2
        AND ref_id IN (${placeholders})
      `,
      [id, scope, ...refIds]
    );

    return res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    console.error('[groups_removeExclusions] error:', err);
    return sendError(res, 500, 'Error al quitar exclusiones');
  }
};

// ===================== GROUPS: CREATE OR MOVE =====================
exports.groups_createOrMove = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const nombre = String(req.body?.nombre || '').trim();
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!nombre || !ids.length) {
    return sendError(res, 400, 'Nombre e IDs son obligatorios');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let destRow;
    {
      const r = await client.query(
        `
        SELECT id, nombre
        FROM insumo_groups
        WHERE business_id = $1 AND nombre = $2
        FOR UPDATE
        `,
        [bizId, nombre]
      );

      if (r.rows.length) {
        destRow = r.rows[0];
      } else {
        const r2 = await client.query(
          `
          INSERT INTO insumo_groups (business_id, nombre)
          VALUES ($1, $2)
          RETURNING id, nombre
          `,
          [bizId, nombre]
        );
        destRow = r2.rows[0];
      }
    }

    const destId = Number(destRow.id);

    await client.query(
      `
      DELETE FROM insumo_group_items
      WHERE group_id IN (
        SELECT id FROM insumo_groups WHERE business_id = $1 AND id != $2
      )
      AND insumo_id = ANY($3::int[])
      `,
      [bizId, destId, ids]
    );

    const placeholders = ids.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(', ');
    const values = ids.flatMap(id => [destId, id]);

    await client.query(
      `
      INSERT INTO insumo_group_items (group_id, insumo_id)
      VALUES ${placeholders}
      ON CONFLICT (group_id, insumo_id) DO NOTHING
      `,
      values
    );

    await client.query('COMMIT');

    console.log(`✅ [groups_createOrMove] Agrupación "${nombre}" (ID: ${destId}) con ${ids.length} insumos`);
    return res.json({ ok: true, id: destId, nombre, moved: ids.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[groups_createOrMove] error:', err);
    return sendError(res, 500, 'Error al crear/mover agrupación');
  } finally {
    client.release();
  }
};
