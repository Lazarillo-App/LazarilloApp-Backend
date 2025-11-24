// controllers/insumosController.js
const pool = require('../config/db');
const { parse } = require('csv-parse/sync');
const { fetchMaxiInsumos, normalizarInsumosMaxi,
  fetchMaxiInsumosRubros, normalizarInsumosRubros } = require('../services/maxiSuppliesService');
const { upsertFromMaxi } = require('../repos/insumosRepo');
const insumosRubrosRepo = require('../repos/insumosRubrosRepo');


const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

if (process.env.NODE_ENV !== 'production') {
  console.log('💡 insumosController.js cargado (modo limpio)');
}

function getBusinessIdFromReq(req) {
  // depende de cómo lo deja loadActiveBusiness, pero cubrimos las 2 variantes
  if (req.business && req.business.id) return Number(req.business.id);
  if (req.user && req.user.active_business_id) return Number(req.user.active_business_id);

  const hdr = req.header('X-Business-Id') || req.query.businessId;
  return hdr ? Number(hdr) : null;
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
      activo = 'true',
      orderBy = 'nombre',
      order = 'ASC',
      elaborados,        // 👈 NUEVO: 'true' | 'false' | undefined
    } = req.query;

    const where = [];
    const params = [];

    // 🔹 Negocio activo (multi-tenant)
    const businessId = getBusinessIdFromReq(req);
    if (businessId) {
      params.push(businessId);
      where.push(`business_id = $${params.length}`);
    }

    // 🔍 búsqueda por nombre / código
    if (search) {
      params.push(`%${search}%`, `%${search}%`);
      where.push(
        `(nombre ILIKE $${params.length - 1} OR codigo_maxi ILIKE $${params.length})`
      );
    }

    // 🔹 filtro por rubro (código Maxi guardado como texto)
    if (rubro) {
      params.push(String(rubro));        // 👈 aseguramos comparar como texto
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
    if (activo !== 'all') {
      params.push(activo === 'true');
      where.push(`activo = $${params.length}`);
    }

    // 🔹 filtro por elaborados / no elaborados usando insumo_rubros
    //   - elaborados = 'true'  → solo rubros con es_elaborador = true
    //   - elaborados = 'false' → rubros donde NO es_elaborador o sin rubro
    if (elaborados === 'true') {
      where.push(`
        EXISTS (
          SELECT 1
          FROM insumo_rubros ir
          WHERE ir.business_id = insumos.business_id
            AND ir.codigo::text = insumos.rubro
            AND ir.es_elaborador = TRUE
        )
      `);
    } else if (elaborados === 'false') {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM insumo_rubros ir
          WHERE ir.business_id = insumos.business_id
            AND ir.codigo::text = insumos.rubro
            AND ir.es_elaborador = TRUE
        )
      `);
    }

    const rawLimit = Number(limit) || 50;
    const hardLimit = Math.min(Math.max(rawLimit, 1), 500); // 🔒 cap ≤ 500
    const currentPage = Math.max(Number(page) || 1, 1);
    const offset = (currentPage - 1) * hardLimit;

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const validOrderByWhitelist = [
      'nombre',
      'codigo_maxi',
      'unidad_med',
      'precio_ref',
      'created_at',
      'updated_at',
    ];
    const validOrderBy = validOrderByWhitelist.includes(orderBy)
      ? orderBy
      : 'nombre';
    const validOrder =
      String(order).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT *
         FROM insumos
         ${whereSql}
         ORDER BY ${validOrderBy} ${validOrder}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, hardLimit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM insumos ${whereSql}`,
        params
      ),
    ]);

    const total = countRes.rows[0].total;
    res.json({
      ok: true,
      data: dataRes.rows,
      pagination: {
        page: currentPage,
        limit: hardLimit,
        total,
        pages: Math.max(Math.ceil(total / hardLimit), 1),
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.actualizar = async (req, res) => {
  try {
    const { id } = req.params, b = req.body || {};
    const sets = [], vals = [];
    const push = (c, v) => { vals.push(v); sets.push(`${c}=$${vals.length}`); };

    if (b.nombre !== undefined) push('nombre', b.nombre);
    if (b.unidadMed !== undefined) push('unidad_med', b.unidadMed);
    if (b.precioRef !== undefined) push('precio_ref', num(b.precioRef));
    if (b.rubro !== undefined) push('rubro', b.rubro);
    if (b.envase !== undefined) push('envase', b.envase);
    if (b.vencimiento !== undefined) push('vencimiento', b.vencimiento);
    if (b.resumen !== undefined) push('resumen', b.resumen);
    if (b.cantIngredientes !== undefined) push('cant_ingredientes', b.cantIngredientes);
    if (b.agrupacionBase !== undefined) push('agrupacion_base', b.agrupacionBase);
    if (b.costoRef !== undefined) push('costo_ref', num(b.costoRef));
    if (b.nota !== undefined) push('nota', b.nota);
    if (b.activo !== undefined) push('activo', b.activo);

    if (!sets.length) return res.json({ ok: true, data: null });

    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE insumos SET ${sets.join(', ')}, updated_at=NOW()
       WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    res.json({ ok: true, data: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.eliminar = async (req, res) => {
  try {
    const { id } = req.params;
    const r = await pool.query(
      `UPDATE insumos SET activo=FALSE, updated_at=NOW() WHERE id=$1`,
      [id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

// ===================== BULK (JSON/CSV) =====================
exports.bulkUpsert = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);
    if (!businessId) {
      return res.status(400).json({ ok:false, error:'Negocio activo requerido' });
    }

    const items = Array.isArray(req.body) ? req.body : [];
    if (!items.length) return res.status(400).json({ ok:false, error:'Body debe ser un array de insumos' });

    const client = await pool.connect();
    let inserted = 0, updated = 0, skipped = 0;

    try {
      await client.query('BEGIN');
      for (const it of items) {
        const codigo = it.codigoMaxi ?? it.codigo_maxi ?? it.codigo ?? null;
        if (!codigo || String(codigo).trim() === '') { skipped++; continue; }

        const nombre     = (it.nombre ?? '').trim();
        const unidad_med = it.unidadMed ?? it.unidad_med ?? null;
        const precio_ref = (it.precioRef ?? it.precio_ref ?? null);
        const origen     = it.origen ?? 'manual';
        const activo     = typeof it.activo === 'boolean' ? it.activo : true;
        const rubro      = it.rubro ?? null;

        const r = await client.query(
          `INSERT INTO insumos (business_id, codigo_maxi, nombre, unidad_med, precio_ref, rubro, origen, activo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (business_id, codigo_maxi) DO UPDATE SET
             nombre=EXCLUDED.nombre,
             unidad_med=EXCLUDED.unidad_med,
             precio_ref=EXCLUDED.precio_ref,
             rubro=EXCLUDED.rubro,
             origen=EXCLUDED.origen,
             activo=EXCLUDED.activo,
             updated_at=NOW()
           RETURNING (xmax = 0) AS inserted`,
          [
            businessId,
            String(codigo),
            nombre,
            unidad_med,
            (precio_ref == null ? null : Number(precio_ref)),
            rubro,
            origen,
            activo
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

    return res.json({ ok:true, summary:{ inserted, updated, skipped, total: inserted+updated+skipped } });
  } catch (e) {
    console.error('bulkUpsert error:', e.message);
    return res.status(500).json({ ok:false, error:e.message });
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
exports.listarMaxi = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const items = await maxiSuppliesRepo.listForBusiness(businessId);
    return res.json({ ok: true, business_id: businessId, items });
  } catch (e) {
    console.error('listarMaxi error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal' });
  }
};

exports.syncFromMaxi = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);   // 👈 USAR SIEMPRE ESTA

    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const raw  = await fetchMaxiInsumos({ businessId, req });
    const norm = normalizarInsumosMaxi(raw);
    const summary = await upsertFromMaxi(businessId, norm); // 👈 ahora pasa businessId

    return res.json({
      ok: true,
      business_id: businessId,
      received: raw.length,
      normalized: norm.length,
      synced: summary.total,
      inserted: summary.inserted,
      updated: summary.updated,
      skipped: summary.skipped,
    });
  } catch (e) {
    console.error('syncFromMaxi error:', e);
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e.message || 'internal_error' });
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

    const decorados = items.map((r) => ({
      ...r,
      es_elaborado: r.nombre
        ? r.nombre.trim().toUpperCase().startsWith('ELABORAD')
        : false,
    }));

    return res.json({ ok: true, business_id: businessId, items: decorados });
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
