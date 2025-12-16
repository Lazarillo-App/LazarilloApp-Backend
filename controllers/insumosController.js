// controllers/insumosController.js
const pool = require('../config/db');
const { parse } = require('csv-parse/sync');

const {
  fetchMaxiInsumos,
  normalizarInsumosMaxi,
  fetchMaxiInsumosRubros,
  normalizarInsumosRubros,
} = require('../services/maxiSuppliesService');

const { upsertFromMaxi } = require('../repos/insumosRepo');   // 👈 ESTE ES EL BUENO
const insumosRubrosRepo = require('../repos/insumosRubrosRepo');

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

if (process.env.NODE_ENV !== 'production') {
  console.log('💡 insumosController.js cargado (modo limpio)');
}

function getBusinessIdFromReq(req) {
  const hdr =
    req.header('X-Business-Id') ||
    req.headers['x-business-id'] ||
    req.query.businessId;

  if (hdr) {
    const n = Number(hdr);
    if (Number.isFinite(n) && n > 0) return n;
  }

  if (req.business?.id) return Number(req.business.id);
  if (req.user?.active_business_id)
    return Number(req.user.active_business_id);

  return null;
}

// ===================== LISTAR / CRUD BÁSICO =====================
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

    const where = [];
    const params = [];

    const businessId = getBusinessIdFromReq(req);
    if (!businessId) {
      return res
        .status(400)
        .json({ ok: false, error: 'Negocio activo requerido' });
    }

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
    const hardLimit = Math.min(Math.max(Number(limit), 1), 500);
    const offset = (Number(page) - 1) * hardLimit;

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `
        SELECT *
        FROM insumos
        ${whereSql}
        ORDER BY ${orderBy} ${order}
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
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.crearManual = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);
    if (!businessId)
      return res
        .status(400)
        .json({ ok: false, error: 'Negocio activo requerido' });

    const b = req.body || {};
    if (!b.nombre?.trim())
      return res
        .status(400)
        .json({ ok: false, error: 'Nombre requerido' });

    const estado =
      b.estado === 'discontinuado' ? 'discontinuado' : 'activo';

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
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.actualizar = async (req, res) => {
  try {
    const { id } = req.params;
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

    if (!sets.length) return res.json({ ok: true });

    vals.push(id);

    const { rows } = await pool.query(
      `
      UPDATE insumos
      SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${vals.length}
      RETURNING *
    `,
      vals
    );

    if (!rows.length)
      return res
        .status(404)
        .json({ ok: false, error: 'Insumo no encontrado' });

    res.json({ ok: true, data: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.eliminar = async (req, res) => {
  try {
    const { id } = req.params;

    const r = await pool.query(
      `
      UPDATE insumos
      SET estado = 'discontinuado', updated_at = NOW()
      WHERE id = $1
    `,
      [id]
    );

    if (!r.rowCount)
      return res
        .status(404)
        .json({ ok: false, error: 'Insumo no encontrado' });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};

// ===================== BULK (JSON/CSV) =====================
exports.bulkUpsert = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const items = Array.isArray(req.body) ? req.body : [];
    if (!items.length) return res.status(400).json({ ok: false, error: 'Body debe ser un array de insumos' });

    const client = await pool.connect();
    let inserted = 0, updated = 0, skipped = 0;

    try {
      await client.query('BEGIN');
      for (const it of items) {
        const codigo = it.codigoMaxi ?? it.codigo_maxi ?? it.codigo ?? null;
        if (!codigo || String(codigo).trim() === '') { skipped++; continue; }

        const nombre = (it.nombre ?? '').trim();
        const unidad_med = it.unidadMed ?? it.unidad_med ?? null;
        const precio_ref = (it.precioRef ?? it.precio_ref ?? null);
        const origen = it.origen ?? 'manual';
        const estado =
          b.estado === 'discontinuado' ? 'discontinuado' : 'activo';

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
        if (r.rows?.[0]?.inserted) inserted++; else updated++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally {
      client.release();
    }

    return res.json({ ok: true, summary: { inserted, updated, skipped, total: inserted + updated + skipped } });
  } catch (e) {
    console.error('bulkUpsert error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

exports.bulkUpsertCSV = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Subí un CSV en el campo "file"' });
    const text = req.file.buffer.toString('utf8');
    const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });

    // Normalizamos columnas comunes y reusamos bulkUpsert
    req.body = rows.map(r => ({
      codigoMaxi: r.codigoMaxi ?? r.codigo_maxi ?? r.codigo,
      nombre: r.nombre ?? '',
      unidadMed: r.unidadMed ?? r.unidad_med ?? null,
      precioRef: r.precioRef ?? r.precio_ref ?? null,
      rubro: r.rubro ?? null,
      origen: r.origen ?? 'csv',
      activo: (String(r.activo ?? 'true').toLowerCase() !== 'false')
    }));

    return exports.bulkUpsert(req, res);
  } catch (e) {
    console.error('bulkUpsertCSV error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ===================== MANTENIMIENTO =====================
exports.__cleanupNullInsumos = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Borra SOLO filas sin nombre (dato claramente inválido).
    const r1 = await client.query(`
      DELETE FROM insumos
      WHERE nombre IS NULL OR TRIM(COALESCE(nombre, '')) = ''
    `);

    // 2) Normaliza espacios
    const r2 = await client.query(`
      UPDATE insumos
         SET nombre = NULLIF(TRIM(nombre), ''),
             unidad_med = NULLIF(TRIM(unidad_med), ''),
             updated_at = NOW()
       WHERE (nombre IS NOT NULL AND nombre <> TRIM(nombre))
          OR (unidad_med IS NOT NULL AND unidad_med <> TRIM(unidad_med))
    `);

    // 3) Colapsa duplicados por codigo_maxi conservando el más antiguo (id menor)
    const r3 = await client.query(`
      DELETE FROM insumos a
      USING insumos b
      WHERE a.id > b.id
        AND a.codigo_maxi IS NOT NULL
        AND a.codigo_maxi = b.codigo_maxi
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

/**
 * Lista insumos desde maxi_supplies para el negocio activo.
 * Esto NO toca la tabla insumos manual; es el espejo directo de Maxi.
 */
/**
 * Lista insumos cargados desde Maxi para el negocio activo,
 * leyendo directamente la tabla `insumos` (origen = 'maxi').
 */
exports.listarMaxi = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);
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
    return res.status(500).json({ ok: false, error: e.message || 'internal' });
  }
};

exports.syncFromMaxi = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);
    if (!businessId)
      return res
        .status(400)
        .json({ ok: false, error: 'Negocio activo requerido' });

    const raw = await fetchMaxiInsumos({ businessId, req });
    const norm = normalizarInsumosMaxi(raw);
    const summary = await upsertFromMaxi(businessId, norm);

    res.json({ ok: true, ...summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};

/**
 * Lista rubros de insumos desde tabla insumo_rubros
 * para el negocio activo.
 */
exports.listarRubrosMaxi = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const items = await insumosRubrosRepo.listRubrosForBusiness(businessId);
    return res.json({ ok: true, business_id: businessId, items });
  } catch (e) {
    console.error('listarRubrosMaxi error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal' });
  }
};

/**
 * Sincroniza rubros de insumos desde Maxi → insumo_rubros.
 */
exports.syncRubrosFromMaxi = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);
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
    return res.status(status).json({ ok: false, error: e.message || 'internal_error' });
  }
};

// ===================== (OPCIONAL) SYNC DESDE COMPRAS =====================
// Dejalo activado sólo si realmente lo vas a usar ahora.
// Para desactivarlo sin borrar, usa la flag de entorno: ENABLE_SYNC_COMPRAS=false
exports.syncDesdeCompras = async (req, res) => {
  if (String(process.env.ENABLE_SYNC_COMPRAS || 'false').toLowerCase() !== 'true') {
    return res.status(503).json({ ok: false, error: 'syncDesdeCompras deshabilitado' });
  }
  return res.status(501).json({ ok: false, error: 'No implementado en modo limpio' });
};
