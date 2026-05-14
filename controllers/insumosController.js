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
const { notifyAutoAssign } = require('../services/notificationService');
const {
  createSyncNotificationForBusinessUsers
} = require('../services/notificationService');

// ===================== HELPERS COMPARTIDOS ====================
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

const ALLOWED_ORDER_BY = ['nombre', 'codigo_maxi', 'rubro', 'unidad_med', 'precio_ref', 'created_at'];

function sendError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

async function assertGroup(executor, bizId, groupId) {
  const r = await executor.query(
    'SELECT 1 FROM insumo_groups WHERE id = $1 AND business_id = $2',
    [groupId, bizId]
  );
  return (r.rowCount || 0) > 0;
}

if (process.env.NODE_ENV !== 'production') {
  console.log('💡 insumosController.js cargado (es_elaborado como fuente de verdad)');
}

// ===================== INSUMOS: LISTAR =====================
exports.listar = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 500000,
      search = '',
      rubro,
      unidadMed,
      origen,
      orderBy = 'nombre',
      order = 'ASC',
      elaborados,
      estado,
      sinAgrupacion,
      groupId,
    } = req.query;

    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const where = [];
    const params = [];

    params.push(businessId);
    where.push(`i.business_id = $${params.length}`);

    if (search) {
      params.push(`%${search}%`, `%${search}%`);
      where.push(
        `(i.nombre ILIKE $${params.length - 1} OR i.codigo_maxi ILIKE $${params.length})`
      );
    }

    if (rubro) {
      params.push(String(rubro));
      where.push(`i.rubro = $${params.length}`);
    }

    if (unidadMed) {
      params.push(unidadMed);
      where.push(`i.unidad_med = $${params.length}`);
    }

    if (origen) {
      params.push(origen);
      where.push(`i.origen = $${params.length}`);
    }

    if (estado && estado !== 'all') {
      params.push(estado);
      where.push(`i.estado = $${params.length}`);
    }

    if (groupId) {
      params.push(Number(groupId));
      where.push(`
        EXISTS (
          SELECT 1
          FROM insumo_group_items gi2
          JOIN insumo_groups g2 ON g2.id = gi2.group_id
          WHERE gi2.insumo_id = i.id
            AND g2.id = $${params.length}
            AND g2.business_id = i.business_id
        )
      `);
    }

    if (sinAgrupacion === 'true') {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM insumo_group_items gi3
          JOIN insumo_groups g3 ON g3.id = gi3.group_id
          WHERE gi3.insumo_id = i.id
            AND g3.business_id = i.business_id
        )
      `);
    }

    // ✅ FUENTE DE VERDAD ÚNICA: es_elaborado en la tabla insumos
    // Ya no consultamos insumo_rubros.es_elaborador para este filtro.
    if (elaborados === 'true') {
      where.push(`i.es_elaborado = true`);
    }

    if (elaborados === 'false') {
      where.push(`(i.es_elaborado = false OR i.es_elaborado IS NULL)`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const hardLimit = Math.min(Math.max(Number(limit), 1), 500000);
    const offset = (Number(page) - 1) * hardLimit;

    const safeOrderBy = ALLOWED_ORDER_BY.includes(orderBy) ? orderBy : 'nombre';
    const safeOrder = order === 'DESC' ? 'DESC' : 'ASC';
    const orderBySql = safeOrderBy.includes('.') ? safeOrderBy : `i.${safeOrderBy}`;

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `
        SELECT 
          i.*,
          ir.nombre as rubro_nombre,
          ir.es_elaborador,
          lc.precio_promedio,
          lc.precio_ultima_compra,
          lc.fecha_ultima_compra,
          COALESCE(
            json_agg(
              DISTINCT jsonb_build_object(
                'id', g.id,
                'nombre', g.nombre
              )
            ) FILTER (WHERE g.id IS NOT NULL),
            '[]'::json
          ) as grupos
        FROM insumos i
        LEFT JOIN insumo_rubros ir 
          ON ir.business_id = i.business_id 
          AND ir.codigo::text = i.rubro
        LEFT JOIN insumo_group_items gi ON gi.insumo_id = i.id
        LEFT JOIN insumo_groups g ON g.id = gi.group_id AND g.business_id = i.business_id
        LEFT JOIN LATERAL (
          SELECT
            ROUND(AVG(CASE WHEN pi_all.fecha >= CURRENT_DATE - INTERVAL '90 days' THEN pi_all.precio END)::numeric, 4) AS precio_promedio,
            (SELECT pi_ult.precio FROM purchase_items pi_ult
             WHERE pi_ult.insumo_id = i.id AND pi_ult.business_id = i.business_id AND pi_ult.precio > 0
             ORDER BY pi_ult.fecha DESC LIMIT 1) AS precio_ultima_compra,
            MAX(pi_all.fecha) AS fecha_ultima_compra
          FROM purchase_items pi_all
          WHERE pi_all.insumo_id = i.id
            AND pi_all.business_id = i.business_id
            AND pi_all.precio > 0
        ) lc ON true
        ${whereSql}
        GROUP BY i.id, ir.nombre, ir.es_elaborador, lc.precio_promedio, lc.precio_ultima_compra, lc.fecha_ultima_compra
        ORDER BY ${orderBySql} ${safeOrder}
        LIMIT $${params.length + 1}
        OFFSET $${params.length + 2}
        `,
        [...params, hardLimit, offset]
      ),
      pool.query(
        `
        SELECT COUNT(DISTINCT i.id)::int AS total 
        FROM insumos i
        LEFT JOIN insumo_rubros ir 
          ON ir.business_id = i.business_id 
          AND ir.codigo::text = i.rubro
        ${whereSql}
        `,
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

// ===================== VISTA DE ÁRBOL (RUBROS) =====================
exports.getTreeView = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    // ✅ Contamos insumos separados por es_elaborado (fuente de verdad),
    //    agrupados por rubro para mantener la estructura del sidebar.
    const { rows: rubros } = await pool.query(
      `
      SELECT 
        ir.codigo,
        ir.nombre,
        ir.es_elaborador,
        COUNT(i.id) FILTER (WHERE i.es_elaborado = true)::int            AS count_elaborados,
        COUNT(i.id) FILTER (WHERE i.es_elaborado = false OR i.es_elaborado IS NULL)::int AS count_no_elaborados
      FROM insumo_rubros ir
      LEFT JOIN insumos i 
        ON i.business_id = ir.business_id 
        AND i.rubro = ir.codigo::text
        AND i.estado = 'activo'
      WHERE ir.business_id = $1
      GROUP BY ir.codigo, ir.nombre, ir.es_elaborador
      ORDER BY ir.nombre ASC
      `,
      [businessId]
    );

    const { rows: sinAgrupar } = await pool.query(
      `
      SELECT COUNT(*)::int as count
      FROM insumos i
      WHERE i.business_id = $1
        AND i.estado = 'activo'
        AND NOT EXISTS (
          SELECT 1
          FROM insumo_group_items gi
          JOIN insumo_groups g ON g.id = gi.group_id
          WHERE gi.insumo_id = i.id
            AND g.business_id = i.business_id
        )
      `,
      [businessId]
    );

    // Totales globales por es_elaborado (independiente del rubro)
    const totalElaborados = rubros.reduce((sum, r) => sum + (r.count_elaborados || 0), 0);
    const totalNoElaborados = rubros.reduce((sum, r) => sum + (r.count_no_elaborados || 0), 0);

    // Rubros que tienen al menos un elaborado / no elaborado
    const rubrosConElaborados = rubros
      .filter(r => r.count_elaborados > 0)
      .map(r => ({ ...r, count_insumos: r.count_elaborados }));

    const rubrosConNoElaborados = rubros
      .filter(r => r.count_no_elaborados > 0)
      .map(r => ({ ...r, count_insumos: r.count_no_elaborados }));

    res.json({
      ok: true,
      data: {
        elaborados: {
          count: totalElaborados,
          rubros: rubrosConElaborados,
        },
        no_elaborados: {
          count: totalNoElaborados,
          rubros: rubrosConNoElaborados,
        },
        sin_agrupar: {
          count: sinAgrupar[0].count,
        },
      },
    });
  } catch (e) {
    console.error('getTreeView error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

// ===================== ESTADÍSTICAS DEL SIDEBAR =====================
exports.getStats = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const { rows } = await pool.query(
      `
      SELECT
        COUNT(*)::int                                                        AS total,
        COUNT(*) FILTER (WHERE estado = 'activo')::int                      AS activos,
        COUNT(*) FILTER (WHERE estado = 'discontinuado')::int               AS discontinuados,
        COUNT(*) FILTER (WHERE origen = 'maxi')::int                        AS de_maxi,
        COUNT(*) FILTER (WHERE origen = 'manual')::int                      AS manuales,
        -- ✅ FUENTE DE VERDAD ÚNICA: es_elaborado
        COUNT(*) FILTER (WHERE es_elaborado = true)::int                    AS elaborados,
        COUNT(*) FILTER (WHERE es_elaborado = false OR es_elaborado IS NULL)::int AS no_elaborados,
        COUNT(*) FILTER (WHERE es_elaborado_manual = true)::int             AS sobrescritos_manualmente,
        COUNT(*) FILTER (
          WHERE NOT EXISTS (
            SELECT 1 FROM insumo_group_items gi
            JOIN insumo_groups g ON g.id = gi.group_id
            WHERE gi.insumo_id = insumos.id
              AND g.business_id = insumos.business_id
          )
        )::int AS sin_agrupar
      FROM insumos
      WHERE business_id = $1
      `,
      [businessId]
    );

    res.json({
      ok: true,
      data: rows[0],
    });
  } catch (e) {
    console.error('getStats error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

// ===================== TOGGLE ELABORADO (marca/desmarca manual) =====================
/**
 * PATCH /api/insumos/:id/elaborado
 * Marca o desmarca un insumo como elaborado.
 * Setea es_elaborado_manual = true para que el sync de Maxi no lo pise.
 */
exports.toggleElaborado = async (req, res) => {
  try {
    const { id } = req.params;
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const { es_elaborado } = req.body;
    if (typeof es_elaborado !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'es_elaborado debe ser boolean' });
    }

    const { rows } = await pool.query(
      `
      UPDATE insumos
      SET
        es_elaborado        = $1,
        es_elaborado_manual = true,   -- el usuario tomó control, el sync no pisa esto
        updated_at          = NOW()
      WHERE id = $2 AND business_id = $3
      RETURNING *
      `,
      [es_elaborado, id, businessId]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }

    res.json({
      ok: true,
      data: rows[0],
      message: es_elaborado ? 'Insumo marcado como elaborado' : 'Insumo marcado como no elaborado',
    });
  } catch (e) {
    console.error('toggleElaborado error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

/**
 * POST /api/insumos/elaborado/bulk
 * Marca/desmarca múltiples insumos como elaborados.
 */
exports.toggleElaboradoBulk = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const { insumo_ids, es_elaborado } = req.body;
    if (!Array.isArray(insumo_ids) || !insumo_ids.length) {
      return res.status(400).json({ ok: false, error: 'insumo_ids debe ser un array no vacío' });
    }
    if (typeof es_elaborado !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'es_elaborado debe ser boolean' });
    }

    const { rowCount } = await pool.query(
      `
      UPDATE insumos
      SET
        es_elaborado        = $1,
        es_elaborado_manual = true,
        updated_at          = NOW()
      WHERE id = ANY($2::int[]) AND business_id = $3
      `,
      [es_elaborado, insumo_ids, businessId]
    );

    res.json({
      ok: true,
      updated: rowCount,
      message: `${rowCount} insumo(s) actualizado(s)`,
    });
  } catch (e) {
    console.error('toggleElaboradoBulk error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

// ===================== INSUMOS: CRUD BÁSICO =====================
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

    // Generar SKU provisorio único: LAZ-{bizId}-{timestamp}-{random}
    // Nunca choca con Maxi (que usa códigos numéricos cortos)
    const skuProvisorio = `LAZ-${businessId}-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // Verificar que no exista ya un insumo con mismo nombre+rubro en este negocio
    const { rows: existing } = await pool.query(
      `SELECT id, codigo_maxi, origen FROM insumos
        WHERE business_id = $1
          AND lower(trim(nombre)) = lower(trim($2))
          AND ($3::text IS NULL OR lower(trim(rubro)) = lower(trim($3)))
        LIMIT 1`,
      [businessId, b.nombre.trim(), b.rubro ?? null]
    );

    if (existing.length) {
      const ex = existing[0];
      return res.status(409).json({
        ok: false,
        error: `Ya existe un insumo con ese nombre${b.rubro ? ' y rubro' : ''}.`,
        existing: { id: ex.id, codigo_maxi: ex.codigo_maxi, origen: ex.origen },
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO insumos
         (business_id, codigo_maxi, nombre, unidad_med, precio_ref, rubro,
          origen, estado, es_elaborado, es_elaborado_manual,
          sin_equivalencia, upload_batch_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'activo',$8,$9,TRUE,$10)
       RETURNING *`,
      [
        businessId,
        skuProvisorio,          // código provisorio de Lazarillo
        b.nombre.trim(),
        b.unidadMed ?? null,
        num(b.precioRef),
        b.rubro ?? null,
        b.origen ?? 'manual',
        b.es_elaborado ?? false,
        b.es_elaborado !== undefined,
        `manual-abm-${new Date().toISOString().slice(0, 10)}`, // batch del día
      ]
    );

    res.status(201).json({ ok: true, data: rows[0], sku: skuProvisorio });
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

    if (b.nombre !== undefined)    push('nombre', b.nombre);
    if (b.unidadMed !== undefined) push('unidad_med', b.unidadMed);
    if (b.precioRef !== undefined) push('precio_ref', num(b.precioRef));
    if (b.rubro !== undefined)     push('rubro', b.rubro);
    if (b.estado !== undefined)    push('estado', b.estado);
    if (b.nota !== undefined)      push('nota', b.nota);

    // ✅ Si actualizan es_elaborado desde este endpoint también, lo respetamos
    if (b.es_elaborado !== undefined) {
      push('es_elaborado', b.es_elaborado);
      push('es_elaborado_manual', true);
    }

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
      `UPDATE insumos SET estado = 'discontinuado', updated_at = NOW()
       WHERE id = $1 AND business_id = $2`,
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

    const batchId = req._batchId || `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const client = await pool.connect();
    let inserted = 0, updated = 0, skipped = 0;

    try {
      await client.query('BEGIN');

      for (const it of items) {
        const nombre = (it.nombre ?? '').trim();
        if (!nombre) { skipped++; continue; }

        const codigo     = it.codigoMaxi ?? it.codigo_maxi ?? it.codigo ?? null;
        const unidad_med = it.unidadMed ?? it.unidad_med ?? null;
        const precio_ref = it.precioRef ?? it.precio_ref ?? null;
        const rubro      = it.rubro ?? null;
        const origen     = it.origen ?? 'manual';
        const esElaborado = it.esElaborado ?? it.es_elaborado ?? false;
        const sinEquiv   = !codigo;

        if (codigo) {
          const r = await client.query(
            `INSERT INTO insumos
               (business_id, codigo_maxi, nombre, unidad_med, precio_ref, rubro,
                origen, estado, upload_batch_id, sin_equivalencia, es_elaborado)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'activo',$8,$9,$10)
             ON CONFLICT (business_id, codigo_maxi) DO UPDATE SET
               nombre          = EXCLUDED.nombre,
               unidad_med      = EXCLUDED.unidad_med,
               precio_ref      = COALESCE(EXCLUDED.precio_ref, insumos.precio_ref),
               rubro           = EXCLUDED.rubro,
               origen          = EXCLUDED.origen,
               upload_batch_id = EXCLUDED.upload_batch_id,
               sin_equivalencia = FALSE,
               updated_at      = NOW()
             RETURNING (xmax = 0) AS inserted`,
            [businessId, String(codigo).trim(), nombre, unidad_med,
             precio_ref == null ? null : Number(precio_ref),
             rubro, origen, batchId, sinEquiv, esElaborado]
          );
          if (r.rows?.[0]?.inserted) inserted++;
          else updated++;
        } else {
          const { rows: existing } = await client.query(
            `SELECT id FROM insumos
              WHERE business_id = $1
                AND lower(trim(nombre)) = lower(trim($2))
                AND origen IN ('manual','csv')
              LIMIT 1`,
            [businessId, nombre]
          );

          if (existing.length) {
            await client.query(
              `UPDATE insumos SET
                 unidad_med      = COALESCE($1, unidad_med),
                 precio_ref      = COALESCE($2, precio_ref),
                 rubro           = COALESCE($3, rubro),
                 upload_batch_id = $4,
                 updated_at      = NOW()
               WHERE id = $5`,
              [unidad_med, precio_ref == null ? null : Number(precio_ref), rubro, batchId, existing[0].id]
            );
            updated++;
          } else {
            await client.query(
              `INSERT INTO insumos
                 (business_id, nombre, unidad_med, precio_ref, rubro,
                  origen, estado, upload_batch_id, sin_equivalencia, es_elaborado)
               VALUES ($1,$2,$3,$4,$5,$6,'activo',$7,TRUE,$8)`,
              [businessId, nombre, unidad_med,
               precio_ref == null ? null : Number(precio_ref),
               rubro, origen, batchId, esElaborado]
            );
            inserted++;
          }
        }
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
      batchId,
      summary: { inserted, updated, skipped, total: inserted + updated + skipped },
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

    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const batchId  = req._batchId || `csv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const fileName = req.file.originalname || 'archivo.csv';
    const ext      = fileName.toLowerCase().split('.').pop();

    let rows;
    if (ext === 'csv') {
      const text = req.file.buffer.toString('utf8');
      rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
    } else if (ext === 'xlsx' || ext === 'xls') {
      try {
        const XLSX = require('xlsx');
        const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        rows       = XLSX.utils.sheet_to_json(ws, { defval: '' });
      } catch {
        return res.status(400).json({ ok: false, error: 'No se pudo leer el Excel. Instalá el paquete xlsx.' });
      }
    } else {
      return res.status(400).json({ ok: false, error: 'Formato no soportado. Usá CSV, XLS o XLSX.' });
    }

    if (!rows?.length) {
      return res.status(400).json({ ok: false, error: 'El archivo está vacío o no tiene filas válidas' });
    }

    const normalize = (key) => String(key || '').toLowerCase().replace(/[\s_\-]/g, '');
    const colMap    = {};
    Object.keys(rows[0] || {}).forEach(k => { colMap[normalize(k)] = k; });

    const getCol = (row, ...aliases) => {
      for (const alias of aliases) {
        const key = colMap[normalize(alias)];
        if (key !== undefined && row[key] !== undefined && String(row[key]).trim() !== '') {
          return String(row[key]).trim();
        }
      }
      return null;
    };

    // Mapeo personalizado enviado desde el front (columna_archivo → campo_interno)
    let mapeoCustom = {};
    if (req.body?.mapeo) {
      try { mapeoCustom = JSON.parse(req.body.mapeo); } catch { /* ignorar */ }
    }

    // Si hay mapeo custom, aplicarlo: invertirlo para que sea campo_interno → columna_archivo
    // Luego renombrar las columnas en cada fila
    if (Object.keys(mapeoCustom).length > 0) {
      rows = rows.map(r => {
        const nueva = {};
        Object.entries(mapeoCustom).forEach(([campoInterno, colArchivo]) => {
          if (colArchivo && r[colArchivo] !== undefined) {
            // Mapear al alias que el getCol reconoce
            nueva[campoInterno] = r[colArchivo];
          }
        });
        // Conservar también las columnas originales (getCol las puede usar)
        return { ...r, ...nueva };
      });
    }

    req.body = rows.map(r => ({
      codigoMaxi: getCol(r, 'codigo', 'CODIGO', 'codigoMaxi', 'codigo_maxi', 'cod', 'SKU', 'sku', 'id'),
      nombre:     getCol(r, 'nombre', 'NOMBRE', 'descripcion', 'DESCRIPCION', 'name', 'producto') ?? '',
      unidadMed:  getCol(r, 'unidad', 'UNIDAD', 'medida', 'MEDIDA', 'unidadMed', 'unidad_med', 'um', 'UM'),
      precioRef:  getCol(r, 'precio', 'PRECIO', 'precioRef', 'precio_ref', 'costo', 'COSTO'),
      rubro:      getCol(r, 'rubro', 'RUBRO', 'categoria', 'CATEGORIA', 'tipo', 'group'),
      esElaborado: ['si','sí','yes','1','true','elaborado'].includes(
        String(getCol(r, 'elaborado', 'ELABORADO', 'esElaborado') || '').toLowerCase()
      ),
      origen: 'csv',
    })).filter(r => r.nombre);

    if (!req.body.length) {
      return res.status(400).json({
        ok: false,
        error: 'No se encontraron filas válidas. El archivo debe tener columna NOMBRE o DESCRIPCION.',
        columnas_detectadas: Object.keys(rows[0] || {}),
      });
    }

    req._batchId  = batchId;
    req._fileName = fileName;
    return exports.bulkUpsert(req, res);
  } catch (e) {
    console.error('bulkUpsertCSV error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

/* ── Listar lotes de subida manual de insumos ── */
exports.listBatchesInsumos = async (req, res, next) => {
  try {
    const bizId = getBusinessId(req);
    if (!bizId) return res.status(400).json({ ok: false, error: 'businessId requerido' });

    const { rows } = await pool.query(
      `SELECT
         COALESCE(upload_batch_id, 'sin-batch-' || origen)  AS batch_id,
         MIN(created_at)                                      AS created_at,
         COUNT(*)::int                                        AS total_items,
         COUNT(*) FILTER (WHERE sin_equivalencia)::int       AS sin_equivalencia,
         COUNT(*) FILTER (WHERE codigo_maxi IS NOT NULL)::int AS con_codigo,
         string_agg(DISTINCT origen, ', ')                   AS origenes
       FROM insumos
       WHERE business_id = $1
         AND origen IN ('csv', 'manual')
       GROUP BY COALESCE(upload_batch_id, 'sin-batch-' || origen)
       ORDER BY MIN(created_at) DESC`,
      [bizId]
    );
    return res.json({ ok: true, data: rows });
  } catch (e) { next(e); }
};

/* ── Eliminar lote de insumos ── */
exports.deleteBatchInsumos = async (req, res, next) => {
  try {
    const bizId   = getBusinessId(req);
    const batchId = req.params.batchId;
    if (!bizId || !batchId) return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });

    let result;
    if (batchId.startsWith('sin-batch-')) {
      // Lote sintético: insumos sin upload_batch_id agrupados por origen
      const origen = batchId.replace('sin-batch-', '');
      result = await pool.query(
        `DELETE FROM insumos
          WHERE business_id = $1
            AND upload_batch_id IS NULL
            AND origen = $2`,
        [bizId, origen]
      );
    } else {
      result = await pool.query(
        `DELETE FROM insumos
          WHERE business_id = $1
            AND upload_batch_id = $2
            AND origen IN ('manual', 'csv')`,
        [bizId, batchId]
      );
    }
    return res.json({ ok: true, deleted: result.rowCount, batchId });
  } catch (e) { next(e); }
};

/* ── Vista previa de un lote ── */
exports.previewBatchInsumos = async (req, res, next) => {
  try {
    const bizId   = getBusinessId(req);
    const batchId = req.params.batchId;
    if (!bizId || !batchId) return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });

    const { rows } = await pool.query(
      `SELECT id, nombre, codigo_maxi, unidad_med, precio_ref, rubro,
              origen, sin_equivalencia, es_elaborado, created_at
         FROM insumos
        WHERE business_id = $1 AND upload_batch_id = $2
        ORDER BY nombre ASC LIMIT 200`,
      [bizId, batchId]
    );
    return res.json({ ok: true, data: rows, total: rows.length });
  } catch (e) { next(e); }
};

// ===================== INSUMOS: MANTENIMIENTO =====================
exports.__cleanupNullInsumos = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r1 = await client.query(`
      DELETE FROM insumos
      WHERE nombre IS NULL OR TRIM(COALESCE(nombre, '')) = ''`);

    const r2 = await client.query(`
      UPDATE insumos
      SET nombre     = NULLIF(TRIM(nombre), ''),
          unidad_med = NULLIF(TRIM(unidad_med), ''),
          updated_at = NOW()
      WHERE (nombre IS NOT NULL AND nombre <> TRIM(nombre))
         OR (unidad_med IS NOT NULL AND unidad_med <> TRIM(unidad_med))`);

    const r3 = await client.query(`
      DELETE FROM insumos a
      USING insumos b
      WHERE a.id > b.id
        AND a.codigo_maxi IS NOT NULL
        AND a.codigo_maxi = b.codigo_maxi
        AND a.business_id = b.business_id`);

    await client.query('COMMIT');
    return res.json({
      ok: true,
      removed_without_name: r1.rowCount,
      normalized: r2.rowCount,
      removed_dupes_by_code: r3.rowCount,
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
      `SELECT * FROM insumos WHERE business_id = $1 AND origen = 'maxi' ORDER BY nombre ASC`,
      [businessId]
    );

    return res.json({ ok: true, business_id: businessId, items: rows });
  } catch (e) {
    console.error('listarMaxi error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

exports.syncFromMaxi = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    const userId = req.user?.id || null;

    // 1️⃣ Fetch + normalización
    const raw = await fetchMaxiInsumos({ businessId, req });
    const normItems = normalizarInsumosMaxi(raw);

    // 2️⃣ Upsert con detección de cambios
    const summary = await upsertFromMaxi(businessId, normItems, { useIncomingEstado: true });

    // 3️⃣ ✅ Auto-inicializar es_elaborado desde el rubro para insumos NO sobrescritos manualmente
    //    Solo toca los que es_elaborado_manual = false/null
    try {
      const { rowCount: autoMarked } = await pool.query(
        `
        UPDATE insumos i
        SET es_elaborado = true,
            updated_at   = NOW()
        FROM insumo_rubros ir
        WHERE ir.business_id = i.business_id
          AND ir.codigo::text = i.rubro
          AND ir.es_elaborador = true
          AND i.business_id = $1
          AND (i.es_elaborado_manual = false OR i.es_elaborado_manual IS NULL)
          AND i.es_elaborado IS DISTINCT FROM true
        `,
        [businessId]
      );

      if (autoMarked > 0) {
        console.log(`[syncFromMaxi] Auto-marcados como elaborados: ${autoMarked} insumos`);
      }
    } catch (e) {
      console.error('[syncFromMaxi] auto-mark elaborados error:', e.message);
    }

    // 4️⃣ Notificación de resumen
    const changedCount = (summary.inserted || 0) + (summary.updated || 0);
    if (changedCount > 0) {
      await createSyncNotificationForBusinessUsers({
        businessId,
        type: 'sync_insumos',
        title: 'Sincronización de insumos completada',
        message:
          `Insertados: ${summary.inserted || 0}, ` +
          `Actualizados: ${summary.updated || 0}, ` +
          `Sin cambios: ${summary.unchanged || 0}.`,
        metadata: {
          scope: 'insumos', source: 'maxi',
          inserted: summary.inserted || 0,
          updated: summary.updated || 0,
          unchanged: summary.unchanged || 0,
        },
        actorUserId: userId,
      });
    }

    // 5️⃣ Notificaciones por ítem (solo si requiere revisión)
    for (const ch of summary.changes || []) {
      const reviewDiffs = (ch.diffs || []).filter(d => d.policy === 'review');
      if (!reviewDiffs.length) continue;

      await createSyncNotificationForBusinessUsers({
        businessId,
        type: 'sync_insumos',
        title: `Cambio en insumo ${ch.codigo_maxi} requiere revisión`,
        message: reviewDiffs
          .map(d => `• ${d.field}: "${d.before ?? ''}" → "${d.after ?? ''}"`)
          .join('\n'),
        metadata: {
          scope: 'insumos', source: 'maxi', policy: 'review',
          insumo_id: ch.insumo_id,
          codigo_maxi: ch.codigo_maxi,
          diffs: reviewDiffs,
        },
        actorUserId: userId,
      });
    }

    // 6️⃣ Auto-assign
    let auto = { assigned: 0, details: [] };
    try {
      auto = await autoAssignNewInsumos(businessId);
      if (auto.assigned > 0 && userId) {
        await notifyAutoAssign({ businessId, userId, result: auto, entity: 'insumos' });
      }
    } catch (e) {
      console.error('[syncFromMaxi] autoAssign error:', e.message);
    }

    const { invalidateCacheForBiz } = require('../middleware/cacheJson');
    invalidateCacheForBiz(businessId);

    res.json({ ok: true, scope: 'insumos', ...summary, auto_assigned: auto.assigned });
  } catch (e) {
    console.error('syncFromMaxi error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

/* ── Rubros de insumos del negocio (para ABM) ── */
exports.getRubrosInsumos = async (req, res, next) => {
  try {
    const bizId = getBusinessId(req);
    if (!bizId) return res.status(400).json({ ok: false, error: 'businessId requerido' });

    const { rows } = await pool.query(
      `SELECT rubro, COUNT(*)::int AS cantidad
         FROM insumos
        WHERE business_id = $1
          AND rubro IS NOT NULL AND rubro != ''
          AND estado = 'activo'
        GROUP BY rubro
        ORDER BY rubro ASC`,
      [bizId]
    );

    return res.json({ ok: true, rubros: rows.map(r => ({ nombre: r.rubro, cantidad: r.cantidad })) });
  } catch (e) { next(e); }
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

    const raw  = await fetchMaxiInsumosRubros({ businessId, req });
    const norm = normalizarInsumosRubros(raw);
    const summary = await insumosRubrosRepo.upsertRubrosForBusiness(businessId, norm);

    // ✅ Después de actualizar rubros, re-inicializar es_elaborado para insumos
    //    que no fueron sobrescritos manualmente y cuyo nuevo rubro es elaborador.
    try {
      await pool.query(
        `
        UPDATE insumos i
        SET es_elaborado = true,
            updated_at   = NOW()
        FROM insumo_rubros ir
        WHERE ir.business_id = i.business_id
          AND ir.codigo::text = i.rubro
          AND ir.es_elaborador = true
          AND i.business_id = $1
          AND (i.es_elaborado_manual = false OR i.es_elaborado_manual IS NULL)
          AND i.es_elaborado IS DISTINCT FROM true
        `,
        [businessId]
      );
    } catch (e) {
      console.error('[syncRubrosFromMaxi] auto-mark error:', e.message);
    }

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

exports.syncDesdeCompras = async (req, res) => {
  if (String(process.env.ENABLE_SYNC_COMPRAS || 'false').toLowerCase() !== 'true') {
    return res.status(503).json({ ok: false, error: 'syncDesdeCompras deshabilitado' });
  }
  return res.status(501).json({ ok: false, error: 'No implementado' });
};

// ===================== GROUPS: LISTAR =====================
exports.groups_list = async (req, res) => {
  console.log('🚀 [groups_list] Listando agrupaciones de insumos');
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

    console.log(`✅ [groups_list] ${rows.length} grupos encontrados`);
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

  const nombre     = String(req.body.nombre || '').trim();
  const descripcion = req.body.descripcion ?? null;
  if (!nombre) return sendError(res, 400, 'El nombre es obligatorio');

  try {
    const { rows } = await pool.query(
      `INSERT INTO insumo_groups (business_id, nombre, descripcion)
       VALUES ($1, $2, $3)
       RETURNING id, business_id, nombre, descripcion, es_favorita, created_at, updated_at`,
      [bizId, nombre, descripcion]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[groups_create] error:', err);
    if (err.code === '23505') return sendError(res, 409, 'Ya existe una agrupación con ese nombre');
    return sendError(res, 500, 'Error al crear agrupación de insumos');
  }
};

exports.groups_update = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return sendError(res, 400, 'ID inválido');

  const nombre      = req.body.nombre != null ? String(req.body.nombre).trim() : null;
  const descripcion = req.body.descripcion ?? null;
  const esFavorita  = req.body.es_favorita;

  if (!nombre && descripcion == null && esFavorita == null) {
    return sendError(res, 400, 'Nada para actualizar');
  }

  const sets   = [];
  const values = [id, bizId];
  let idx = values.length;

  if (nombre != null && nombre !== '') { idx++; sets.push(`nombre = $${idx}`);      values.push(nombre); }
  if (descripcion !== undefined)        { idx++; sets.push(`descripcion = $${idx}`); values.push(descripcion); }
  if (esFavorita !== undefined)         { idx++; sets.push(`es_favorita = $${idx}`); values.push(Boolean(esFavorita)); }
  sets.push('updated_at = now()');

  try {
    const { rows } = await pool.query(
      `UPDATE insumo_groups SET ${sets.join(', ')}
       WHERE id = $1 AND business_id = $2
       RETURNING id, business_id, nombre, descripcion, es_favorita, created_at, updated_at`,
      values
    );
    if (!rows.length) return sendError(res, 404, 'not_found');
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('[groups_update] error:', err);
    if (err.code === '23505') return sendError(res, 409, 'Ya existe una agrupación con ese nombre');
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

  const groupId   = Number(req.params.id);
  if (!Number.isFinite(groupId)) return sendError(res, 400, 'ID inválido');

  const insumoIds = (req.body.insumoIds || [])
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0);

  const client = await pool.connect();
  try {
    const ok = await assertGroup(client, bizId, groupId);
    if (!ok) return sendError(res, 404, 'not_found');

    await client.query('BEGIN');
    await client.query('DELETE FROM insumo_group_items WHERE group_id = $1', [groupId]);

    if (insumoIds.length) {
      const ph  = insumoIds.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(', ');
      const val = insumoIds.flatMap(id => [groupId, id]);
      await client.query(
        `INSERT INTO insumo_group_items (group_id, insumo_id) VALUES ${ph} ON CONFLICT DO NOTHING`,
        val
      );
    }

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    console.error('[groups_replaceItems] error:', err);
    await client.query('ROLLBACK').catch(() => {});
    return sendError(res, 500, 'Error al actualizar items de la agrupación');
  } finally {
    client.release();
  }
};

exports.groups_addItem = async (req, res) => {
  const bizId    = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const groupId  = Number(req.params.id);
  const insumoId = Number(req.body.insumoId);
  if (!Number.isFinite(groupId)  || groupId  <= 0) return sendError(res, 400, 'IDs inválidos');
  if (!Number.isFinite(insumoId) || insumoId <= 0) return sendError(res, 400, 'IDs inválidos');

  try {
    const ok = await assertGroup(pool, bizId, groupId);
    if (!ok) return sendError(res, 404, 'not_found');

    await pool.query(
      `INSERT INTO insumo_group_items (group_id, insumo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
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

  const groupId   = Number(req.params.id);
  const insumoIds = Array.isArray(req.body?.insumoIds)
    ? req.body.insumoIds.map(Number).filter(n => Number.isFinite(n) && n > 0)
    : [];

  if (!Number.isFinite(groupId) || groupId <= 0) return sendError(res, 400, 'ID inválido');
  if (!insumoIds.length) return sendError(res, 400, 'Se requiere un array de insumoIds');

  const client = await pool.connect();
  try {
    const ok = await assertGroup(client, bizId, groupId);
    if (!ok) return sendError(res, 404, 'not_found');

    await client.query('BEGIN');
    const ph  = insumoIds.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(', ');
    const val = insumoIds.flatMap(id => [groupId, id]);
    const r = await client.query(
      `INSERT INTO insumo_group_items (group_id, insumo_id) VALUES ${ph} ON CONFLICT DO NOTHING`,
      val
    );
    await client.query('COMMIT');
    return res.json({ ok: true, added: r.rowCount || 0 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[groups_addMultiple] error:', err);
    return sendError(res, 500, err.message || 'Error al agregar insumos en bulk');
  } finally {
    client.release();
  }
};

exports.groups_removeItem = async (req, res) => {
  const bizId    = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const groupId  = Number(req.params.id);
  const insumoId = Number(req.params.insumoId);
  if (!Number.isFinite(groupId)  || groupId  <= 0) return sendError(res, 400, 'ID inválido');
  if (!Number.isFinite(insumoId) || insumoId <= 0) return sendError(res, 400, 'ID inválido');

  try {
    const ok = await assertGroup(pool, bizId, groupId);
    if (!ok) return sendError(res, 404, 'not_found');

    const r = await pool.query(
      'DELETE FROM insumo_group_items WHERE group_id = $1 AND insumo_id = $2',
      [groupId, insumoId]
    );
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
      `SELECT id, scope, ref_id FROM insumo_group_exclusions WHERE group_id = $1 ORDER BY created_at DESC`,
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

    const values = [], placeholders = [];
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
      `INSERT INTO insumo_group_exclusions (group_id, scope, ref_id) VALUES ${placeholders.join(', ')} ON CONFLICT DO NOTHING`,
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
  if (!Array.isArray(ids) || !ids.length) return sendError(res, 400, 'ids debe ser un array no vacío');

  try {
    const ok = await assertGroup(pool, bizId, id);
    if (!ok) return sendError(res, 404, 'not_found');

    const refIds = ids.map(Number).filter(Number.isFinite);
    if (!refIds.length) return sendError(res, 400, 'No hay IDs válidos para eliminar');

    const ph = refIds.map((_, idx) => `$${idx + 3}`).join(', ');
    const { rowCount } = await pool.query(
      `DELETE FROM insumo_group_exclusions WHERE group_id = $1 AND scope = $2 AND ref_id IN (${ph})`,
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
  const ids    = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0);

  if (!nombre || !ids.length) return sendError(res, 400, 'Nombre e IDs son obligatorios');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let destRow;
    const r = await client.query(
      `SELECT id, nombre FROM insumo_groups WHERE business_id = $1 AND nombre = $2 FOR UPDATE`,
      [bizId, nombre]
    );
    if (r.rows.length) {
      destRow = r.rows[0];
    } else {
      const r2 = await client.query(
        `INSERT INTO insumo_groups (business_id, nombre) VALUES ($1, $2) RETURNING id, nombre`,
        [bizId, nombre]
      );
      destRow = r2.rows[0];
    }

    const destId = Number(destRow.id);

    await client.query(
      `DELETE FROM insumo_group_items
       WHERE group_id IN (SELECT id FROM insumo_groups WHERE business_id = $1 AND id != $2)
         AND insumo_id = ANY($3::int[])`,
      [bizId, destId, ids]
    );

    const ph  = ids.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(', ');
    const val = ids.flatMap(id => [destId, id]);
    await client.query(
      `INSERT INTO insumo_group_items (group_id, insumo_id) VALUES ${ph} ON CONFLICT DO NOTHING`,
      val
    );

    await client.query('COMMIT');
    console.log(`✅ [groups_createOrMove] "${nombre}" (ID: ${destId}) con ${ids.length} insumos`);
    return res.json({ ok: true, id: destId, nombre, moved: ids.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[groups_createOrMove] error:', err);
    return sendError(res, 500, 'Error al crear/mover agrupación');
  } finally {
    client.release();
  }
};