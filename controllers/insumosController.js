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
const { recalcularCostoRecetas } = require('../services/costoRecetaService');
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

// Conversión de unidad para recálculo de costo (espejo básico del front)
function factorConversion(from, to) {
  const norm = (u) => {
    const n = String(u || 'u').toLowerCase().trim();
    return { k: 'kg', g: 'gr', l: 'lt', cc: 'ml' }[n] || n;
  };
  const PESO = { gr: 1, kg: 1000, oz: 28.35, lb: 453.59 };
  const VOLUM = { ml: 1, lt: 1000, oz: 30 };
  const f = norm(from), t = norm(to);
  if (f === t) return 1;
  if (PESO[f] !== undefined && PESO[t] !== undefined) return PESO[f] / PESO[t];
  if (VOLUM[f] !== undefined && VOLUM[t] !== undefined) return VOLUM[f] / VOLUM[t];
  // cruce peso↔volumen (densidad 1)
  const baseF = PESO[f] !== undefined ? PESO[f] : VOLUM[f];
  const baseT = PESO[t] !== undefined ? PESO[t] : VOLUM[t];
  if (baseF !== undefined && baseT !== undefined) return baseF / baseT;
  return 1;
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

    // Elaborado = tiene receta activa. Única fuente de verdad.
    const tieneRecetaSQL = `EXISTS (
      SELECT 1 FROM recetas r_el
      WHERE r_el.insumo_id = i.id
        AND r_el.business_id = i.business_id
        AND r_el.active = TRUE
    )`;

    if (elaborados === 'true')  where.push(tieneRecetaSQL);
    if (elaborados === 'false') where.push(`NOT ${tieneRecetaSQL}`);

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
          lc.cantidad_compras,
          rc.receta_updated_at,
          CASE
            WHEN i.costo_preferido IS NOT NULL THEN i.costo_preferido
            WHEN rc.receta_updated_at IS NULL THEN 'compra'
            WHEN lc.fecha_ultima_compra IS NULL THEN 'elaboracion'
            WHEN lc.fecha_ultima_compra > rc.receta_updated_at THEN 'compra'
            ELSE 'elaboracion'
          END AS costo_efectivo_origen,
          COALESCE(
            json_agg(
              DISTINCT jsonb_build_object(
                'id', g.id,
                'nombre', g.nombre
              )
            ) FILTER (WHERE g.id IS NOT NULL),
            '[]'::json
          ) as grupos,
          (SELECT COUNT(DISTINCT ri.receta_id)::int
             FROM receta_items ri
             JOIN recetas r2 ON r2.id = ri.receta_id
            WHERE ri.insumo_id = i.id
              AND r2.business_id = i.business_id
              AND r2.active = TRUE) AS en_recetas
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
            MAX(pi_all.fecha) AS fecha_ultima_compra,
            COUNT(*)::int AS cantidad_compras
          FROM purchase_items pi_all
          WHERE pi_all.insumo_id = i.id
            AND pi_all.business_id = i.business_id
            AND pi_all.precio > 0
        ) lc ON true
        LEFT JOIN LATERAL (
          SELECT
            r.updated_at         AS receta_updated_at,
            r.rendimiento_unidad AS receta_rend_unidad,
            r.rendimiento_peso   AS receta_rend_peso,
            r.unidad_peso        AS receta_unidad_peso,
            r.porciones          AS receta_porciones,
            r.costo_unitario     AS receta_costo_unitario
          FROM recetas r
          WHERE r.insumo_id = i.id
            AND r.business_id = i.business_id
            AND r.active = TRUE
          ORDER BY r.updated_at DESC
          LIMIT 1
        ) rc ON true
        ${whereSql}
        GROUP BY i.id, ir.nombre, ir.es_elaborador, lc.precio_promedio, lc.precio_ultima_compra, lc.fecha_ultima_compra, lc.cantidad_compras, rc.receta_updated_at, rc.receta_rend_unidad, rc.receta_rend_peso, rc.receta_unidad_peso, rc.receta_porciones, rc.receta_costo_unitario
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

    const totalElaborados = rubros.reduce((sum, r) => sum + (r.count_elaborados || 0), 0);
    const totalNoElaborados = rubros.reduce((sum, r) => sum + (r.count_no_elaborados || 0), 0);

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

// ===================== TOGGLE ELABORADO =====================
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
        es_elaborado_manual = true,
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

    // SKU externo del PDV si viene; sino queda null y se genera provisorio post-insert
    const skuExterno = (b.skuExterno && String(b.skuExterno).trim()) || null;

    // Si el usuario puso un SKU externo, verificar que no exista ya ese código.
    // El codigo_maxi es la llave de fusión con MaxiRest: si ya existe, no se puede
    // duplicar — el usuario debe editar el insumo existente. La fusión con Maxi
    // ocurre automáticamente en el sync cuando llega ese código.
    if (b.skuExterno && String(b.skuExterno).trim()) {
      const codigo = String(b.skuExterno).trim();
      const { rows: dupCodigo } = await pool.query(
        `SELECT id, nombre, origen FROM insumos
          WHERE business_id = $1 AND codigo_maxi = $2
          LIMIT 1`,
        [businessId, codigo]
      );
      if (dupCodigo.length) {
        const ex = dupCodigo[0];
        return res.status(409).json({
          ok: false,
          error: `Ya existe un insumo con el código ${codigo}: "${ex.nombre}"${ex.origen === 'maxi' ? ' (sincronizado de Maxi)' : ''}. Editá ese insumo en lugar de crear uno nuevo.`,
          existing: { id: ex.id, codigo_maxi: codigo, origen: ex.origen },
        });
      }
    }

    // Resolver el rubro: si viene como NOMBRE, convertirlo a CÓDIGO para
    // que quede consistente con los insumos de Maxi (que guardan código).
    // Así el JOIN ir.codigo::text = i.rubro los agrupa en el mismo rubro.
    // Se resuelve ANTES del chequeo de duplicados para que la comparación
    // por rubro también use el código, igual que los insumos ya existentes.
    let rubroFinal = b.rubro ?? null;
    if (rubroFinal) {
      const { rows: rubroRows } = await pool.query(
        `SELECT codigo FROM insumo_rubros
          WHERE business_id = $1 AND lower(trim(nombre)) = lower(trim($2))
          LIMIT 1`,
        [businessId, rubroFinal]
      );
      if (rubroRows.length) {
        rubroFinal = String(rubroRows[0].codigo);   // guardar el código
      }
      // Si no existe en insumo_rubros (rubro nuevo/manual), se guarda el nombre tal cual
    }

    const { rows: existing } = await pool.query(
      `SELECT id, codigo_maxi, origen FROM insumos
        WHERE business_id = $1
          AND lower(trim(nombre)) = lower(trim($2))
          AND ($3::text IS NULL OR lower(trim(rubro)) = lower(trim($3)))
        LIMIT 1`,
      [businessId, b.nombre.trim(), rubroFinal]
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
       VALUES ($1,$2,$3,$4,$5,$6,$7,'activo',$8,$9,$10,$11)
       RETURNING *`,
      [
        businessId,
        skuExterno,
        b.nombre.trim(),
        b.unidadMed ?? null,
        num(b.precioRef),
        rubroFinal,
        b.origen ?? 'manual',
        b.es_elaborado ?? false,
        b.es_elaborado !== undefined,
        !skuExterno,
        `manual-abm-${new Date().toISOString().slice(0, 10)}`,
      ]
    );

    // Si no vino SKU externo, generar correlativo L1, L2, L3... por negocio
    let skuFinal = skuExterno;
    if (!skuExterno) {
      const { rows: seqRows } = await pool.query(
        `SELECT codigo_maxi FROM insumos
          WHERE business_id = $1 AND codigo_maxi ~ '^L[0-9]+$'
          ORDER BY (substring(codigo_maxi from 2))::int DESC
          LIMIT 1`,
        [businessId]
      );
      const ultimo = seqRows[0]?.codigo_maxi ? parseInt(seqRows[0].codigo_maxi.slice(1), 10) : 0;
      skuFinal = `L${ultimo + 1}`;
      await pool.query(
        `UPDATE insumos SET codigo_maxi = $1 WHERE id = $2`,
        [skuFinal, rows[0].id]
      );
      rows[0].codigo_maxi = skuFinal;
    }

    // Persistir agrupación heredada del padrino (o elegida manualmente)
    const agrupacionId = Number(b.agrupacionId) || null;
    if (agrupacionId) {
      await pool.query(
        `INSERT INTO insumo_group_items (group_id, insumo_id)
         VALUES ($1, $2)
         ON CONFLICT (group_id, insumo_id) DO NOTHING`,
        [agrupacionId, rows[0].id]
      );
    }

    const { invalidateCacheForBiz } = require('../middleware/cacheJson');
    invalidateCacheForBiz(businessId);

    res.status(201).json({ ok: true, data: rows[0], sku: skuFinal });
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
    if (b.contenidoEnvase !== undefined) push('contenido_envase', b.contenidoEnvase === null || b.contenidoEnvase === '' ? null : num(b.contenidoEnvase));
    if (b.unidadEnvase !== undefined) push('unidad_envase', b.unidadEnvase || null);
    if (b.rubro !== undefined) push('rubro', b.rubro);
    if (b.estado !== undefined) push('estado', b.estado);
    if (b.nota !== undefined) push('nota', b.nota);
    if (b.costoPreferido !== undefined) push('costo_preferido', b.costoPreferido || null);

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
    const { invalidateCacheForBiz } = require('../middleware/cacheJson');
    invalidateCacheForBiz(businessId);
    res.json({ ok: true, data: rows[0] });
  } catch (e) {
    console.error('actualizar error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

// GET /insumos/:id/compras — historial de compras de un insumo
// GET /insumos/:id/compras — historial de compras de un insumo
exports.getCompras = async (req, res) => {
  try {
    const { id } = req.params;
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'business_id requerido' });
    }
    const { rows } = await pool.query(
      `SELECT
         pi.id,
         pi.fecha,
         pi.cantidad,
         pi.precio,
         pi.precio_total,
         pi.referencia,
         pi.source,
         pi.branch_id,
         p.factura_key,
         p.proveedor_id
       FROM purchase_items pi
       LEFT JOIN purchases p ON p.id = pi.purchase_id AND p.business_id = pi.business_id
       WHERE pi.insumo_id = $1
         AND pi.business_id = $2
         AND pi.precio > 0
       ORDER BY pi.fecha DESC, pi.id DESC
       LIMIT 100`,
      [id, businessId]
    );
    return res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('getCompras error:', e);
    return res.status(500).json({ ok: false, error: 'Error al obtener compras del insumo' });
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

// ===================== INSUMOS: BULK =====================
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

        const codigo = it.codigoMaxi ?? it.codigo_maxi ?? it.codigo ?? null;
        const unidad_med = it.unidadMed ?? it.unidad_med ?? null;
        const precio_ref = it.precioRef ?? it.precio_ref ?? null;
        const rubro = it.rubro ?? null;
        const origen = it.origen ?? 'manual';
        const esElaborado = it.esElaborado ?? it.es_elaborado ?? false;
        const sinEquiv = !codigo;

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

    const batchId = req._batchId || `csv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const fileName = req.file.originalname || 'archivo.csv';
    const ext = fileName.toLowerCase().split('.').pop();

    let rows;
    if (ext === 'csv') {
      const text = req.file.buffer.toString('utf8');
      rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
    } else if (ext === 'xlsx' || ext === 'xls') {
      try {
        const XLSX = require('xlsx');
        const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
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
    const colMap = {};
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

    let mapeoCustom = {};
    if (req.body?.mapeo) {
      try { mapeoCustom = JSON.parse(req.body.mapeo); } catch { /* ignorar */ }
    }

    if (Object.keys(mapeoCustom).length > 0) {
      rows = rows.map(r => {
        const nueva = {};
        Object.entries(mapeoCustom).forEach(([campoInterno, colArchivo]) => {
          if (colArchivo && r[colArchivo] !== undefined) {
            nueva[campoInterno] = r[colArchivo];
          }
        });
        return { ...r, ...nueva };
      });
    }

    req.body = rows.map(r => ({
      codigoMaxi: getCol(r, 'codigo', 'CODIGO', 'codigoMaxi', 'codigo_maxi', 'cod', 'SKU', 'sku', 'id'),
      nombre: getCol(r, 'nombre', 'NOMBRE', 'descripcion', 'DESCRIPCION', 'name', 'producto') ?? '',
      unidadMed: getCol(r, 'unidad', 'UNIDAD', 'medida', 'MEDIDA', 'unidadMed', 'unidad_med', 'um', 'UM'),
      precioRef: getCol(r, 'precio', 'PRECIO', 'precioRef', 'precio_ref', 'costo', 'COSTO'),
      rubro: getCol(r, 'rubro', 'RUBRO', 'categoria', 'CATEGORIA', 'tipo', 'group'),
      esElaborado: ['si', 'sí', 'yes', '1', 'true', 'elaborado'].includes(
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

    req._batchId = batchId;
    req._fileName = fileName;
    return exports.bulkUpsert(req, res);
  } catch (e) {
    console.error('bulkUpsertCSV error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

/* ── Listar lotes ── */
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

/* ── Eliminar lote ── */
exports.deleteBatchInsumos = async (req, res, next) => {
  try {
    const bizId = getBusinessId(req);
    const batchId = req.params.batchId;
    if (!bizId || !batchId) return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });

    let result;
    if (batchId.startsWith('sin-batch-')) {
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

/* ── Vista previa de lote ── */
exports.previewBatchInsumos = async (req, res, next) => {
  try {
    const bizId = getBusinessId(req);
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

// ===================== INSUMOS: MAXI SYNC (DB-FIRST) =====================
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

/**
 * syncFromMaxi — DB-FIRST
 * Si MaxiRest no está disponible, responde con datos de DB sin error.
 * Solo actualiza cuando MaxiRest devuelve datos válidos.
 */
exports.syncFromMaxi = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    const userId = req.user?.id || null;

    // ── 1. Intentar fetch de MaxiRest ──
    let normItems = [];
    let maxiAvailable = true;
    let maxiWarning = null;

    try {
      const raw = await fetchMaxiInsumos({ businessId, req });
      normItems = normalizarInsumosMaxi(raw);
    } catch (fetchErr) {
      maxiAvailable = false;
      maxiWarning = `MaxiRest no disponible: ${fetchErr.message}`;
      console.warn(`[syncFromMaxi] MaxiRest caído, usando DB como fuente: ${fetchErr.message}`);
    }

    // ── 2. Si MaxiRest no está disponible → responder con datos de DB ──
    if (!maxiAvailable) {
      const { rows: dbStats } = await pool.query(
        `SELECT COUNT(*)::int as total FROM insumos WHERE business_id = $1 AND estado = 'activo'`,
        [businessId]
      );
      return res.json({
        ok: true,
        scope: 'insumos',
        fromCache: true,
        warning: maxiWarning,
        inserted: 0,
        updated: 0,
        unchanged: dbStats[0]?.total || 0,
        auto_assigned: 0,
        message: 'Lazarillo funcionando con datos locales — MaxiRest temporalmente no disponible',
      });
    }

    // ── 2.5. Guardas defensivas contra respuestas raras de MaxiRest ──
    // Si la API responde OK pero con array vacío o con muy pocos items
    // comparado con lo que ya tenemos, abortamos para no romper la DB.
    if (normItems.length === 0) {
      console.warn(`[syncFromMaxi] MaxiRest devolvió 0 insumos. Sync abortada.`);
      return res.json({
        ok: true,
        scope: 'insumos',
        skipped: true,
        message: 'MaxiRest devolvió 0 items — sync saltada para proteger datos',
        inserted: 0,
        updated: 0,
        unchanged: 0,
        auto_assigned: 0,
      });
    }

    const { rows: [{ total: totalEnDb }] } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM insumos
       WHERE business_id = $1 AND origen = 'maxi' AND estado = 'activo'`,
      [businessId]
    );

    if (totalEnDb > 50 && normItems.length < totalEnDb * 0.5) {
      console.warn(`[syncFromMaxi] ⚠ MaxiRest devolvió ${normItems.length} insumos pero en DB hay ${totalEnDb}. Sync abortada.`);
      return res.json({
        ok: true,
        scope: 'insumos',
        skipped: true,
        warning: `MaxiRest devolvió ${normItems.length} insumos (DB tiene ${totalEnDb}). Sync abortada — posible problema en MaxiRest.`,
        inserted: 0,
        updated: 0,
        unchanged: totalEnDb,
        auto_assigned: 0,
      });
    }

    // ── 3. Upsert con detección de cambios ──
    const summary = await upsertFromMaxi(businessId, normItems, { useIncomingEstado: true });

    // ── 5. Notificación de resumen ──
    const changedCount = (summary.inserted || 0) + (summary.updated || 0);
    if (changedCount > 0) {
      await createSyncNotificationForBusinessUsers({
        businessId,
        type: 'sync_insumos',
        title: 'Sincronización de insumos completada',
        message: `Insertados: ${summary.inserted || 0}, Actualizados: ${summary.updated || 0}, Sin cambios: ${summary.unchanged || 0}.`,
        metadata: { scope: 'insumos', source: 'maxi', inserted: summary.inserted || 0, updated: summary.updated || 0, unchanged: summary.unchanged || 0 },
        actorUserId: userId,
      }).catch(e => console.warn('[syncFromMaxi] notif error:', e.message));
    }

    // ── 6. Notificaciones por ítem (solo review) ──
    for (const ch of summary.changes || []) {
      const reviewDiffs = (ch.diffs || []).filter(d => d.policy === 'review');
      if (!reviewDiffs.length) continue;
      await createSyncNotificationForBusinessUsers({
        businessId,
        type: 'sync_insumos',
        title: `Cambio en insumo ${ch.codigo_maxi} requiere revisión`,
        message: reviewDiffs.map(d => `• ${d.field}: "${d.before ?? ''}" → "${d.after ?? ''}"`).join('\n'),
        metadata: { scope: 'insumos', source: 'maxi', policy: 'review', insumo_id: ch.insumo_id, codigo_maxi: ch.codigo_maxi, diffs: reviewDiffs },
        actorUserId: userId,
      }).catch(() => { });
    }

    // ── 7. Auto-assign ──
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

/* ── Rubros de insumos (para ABM) ── */
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

    const maxiItems = await insumosRubrosRepo.listRubrosForBusiness(businessId);

    const maxiRubroNames = new Set(maxiItems.map(r => (r.nombre || '').trim().toLowerCase()));

    const { rows: manualRubros } = await pool.query(
      `SELECT DISTINCT rubro AS nombre, BOOL_OR(es_elaborado) AS es_elaborador
         FROM insumos
        WHERE business_id = $1
          AND rubro IS NOT NULL AND rubro != ''
          AND estado = 'activo'
        GROUP BY rubro
        ORDER BY rubro ASC`,
      [businessId]
    );

    const syntheticItems = manualRubros
      .filter(r => !maxiRubroNames.has((r.nombre || '').trim().toLowerCase()))
      .map((r, i) => ({
        id: null,
        codigo: `manual_${i}`,
        nombre: r.nombre,
        es_elaborador: r.es_elaborador === true,
        activo: true,
        origen: 'manual',
      }));

    const items = [...maxiItems, ...syntheticItems];
    return res.json({ ok: true, business_id: businessId, items });
  } catch (e) {
    console.error('listarRubrosMaxi error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

/**
 * syncRubrosFromMaxi — DB-FIRST
 * Si MaxiRest no está disponible, responde con datos de DB sin error.
 */
exports.syncRubrosFromMaxi = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    // ── 1. Intentar fetch de MaxiRest ──
    let raw = [];
    let maxiAvailable = true;
    let maxiWarning = null;

    try {
      raw = await fetchMaxiInsumosRubros({ businessId, req });
    } catch (fetchErr) {
      maxiAvailable = false;
      maxiWarning = `MaxiRest no disponible: ${fetchErr.message}`;
      console.warn(`[syncRubrosFromMaxi] MaxiRest caído, usando DB: ${fetchErr.message}`);
    }

    // ── 2. Si MaxiRest no está disponible → responder con datos de DB ──
    if (!maxiAvailable) {
      const dbRubros = await insumosRubrosRepo.listRubrosForBusiness(businessId);
      return res.json({
        ok: true,
        business_id: businessId,
        fromCache: true,
        warning: maxiWarning,
        received: 0,
        normalized: 0,
        inserted: 0,
        updated: 0,
        total: dbRubros.length,
        message: `Lazarillo funcionando con ${dbRubros.length} rubros locales — MaxiRest temporalmente no disponible`,
      });
    }

    // ── 3. Upsert en DB ──
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

exports.syncDesdeCompras = async (req, res) => {
  if (String(process.env.ENABLE_SYNC_COMPRAS || 'false').toLowerCase() !== 'true') {
    return res.status(503).json({ ok: false, error: 'syncDesdeCompras deshabilitado' });
  }
  return res.status(501).json({ ok: false, error: 'No implementado' });
};

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

// ===================== GROUPS =====================
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

exports.groups_create = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const nombre = String(req.body.nombre || '').trim();
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

  const nombre = req.body.nombre != null ? String(req.body.nombre).trim() : null;
  const descripcion = req.body.descripcion ?? null;
  const esFavorita = req.body.es_favorita;

  if (!nombre && descripcion == null && esFavorita == null) {
    return sendError(res, 400, 'Nada para actualizar');
  }

  const sets = [];
  const values = [id, bizId];
  let idx = values.length;

  if (nombre != null && nombre !== '') { idx++; sets.push(`nombre = $${idx}`); values.push(nombre); }
  if (descripcion !== undefined) { idx++; sets.push(`descripcion = $${idx}`); values.push(descripcion); }
  if (esFavorita !== undefined) { idx++; sets.push(`es_favorita = $${idx}`); values.push(Boolean(esFavorita)); }
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

exports.groups_replaceItems = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const groupId = Number(req.params.id);
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
      const ph = insumoIds.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(', ');
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

  const groupId = Number(req.params.id);
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
    const ph = insumoIds.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(', ');
    const val = insumoIds.flatMap(id => [groupId, id]);
    const r = await client.query(
      `INSERT INTO insumo_group_items (group_id, insumo_id) VALUES ${ph} ON CONFLICT DO NOTHING`,
      val
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

exports.groups_createOrMove = async (req, res) => {
  const bizId = getBusinessId(req);
  if (!bizId) return sendError(res, 400, 'business_id requerido');

  const nombre = String(req.body?.nombre || '').trim();
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
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

    const ph = ids.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(', ');
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

/**
 * POST /businesses/:id/insumos/import-csv-paired
 * Body multipart con dos archivos:
 *   - rubros: xls/xlsx de rubros (opcional, si ya están en DB se omite)
 *   - insumos: xls/xlsx de insumos (requerido)
 *
 * Cruza COD_RUI ↔ codigo de rubro para asignar el rubro correcto.
 * Marca es_elaborado = true en insumos cuyo rubro tenga es_elaborador = true.
 */
exports.importCsvPaired = async (req, res) => {
  const businessId = getBusinessId(req);
  if (!businessId) return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });

  const filesArr = Array.isArray(req.files) ? req.files : [];
  const fileRubros = filesArr.find(f => f.fieldname === 'rubros') || req.files?.rubros?.[0] || null;
  const fileInsumos = filesArr.find(f => f.fieldname === 'insumos') || req.files?.insumos?.[0] || null;

  if (!fileInsumos) {
    return res.status(400).json({ ok: false, error: 'El archivo de insumos es requerido (campo "insumos")' });
  }

  // ── Parser xlsx/xls/csv común ──
  const XLSX = require('xlsx');
  const parseFile = (file) => {
    const ext = file.originalname.toLowerCase().split('.').pop();
    if (ext === 'csv') {
      const { parse } = require('csv-parse/sync');
      const text = file.buffer.toString('utf8');
      return parse(text, { columns: true, skip_empty_lines: true, trim: true });
    }
    const wb = XLSX.read(file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: '' });
  };

  const normKey = (k) => String(k || '').toLowerCase().replace(/[\s_\-.]/g, '');
  const getCol = (row, ...aliases) => {
    const map = {};
    Object.keys(row).forEach(k => { map[normKey(k)] = k; });
    for (const a of aliases) {
      const k = map[normKey(a)];
      if (k !== undefined && row[k] !== undefined && String(row[k]).trim() !== '') {
        return String(row[k]).trim();
      }
    }
    return null;
  };

  const batchId = `paired-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── 1. RUBROS (opcional) ──
    let rubrosInserted = 0, rubrosUpdated = 0;
    if (fileRubros) {
      const rows = parseFile(fileRubros);
      for (const row of rows) {
        const codigo = Number(getCol(row, 'codigo', 'cod', 'id'));
        const nombre = getCol(row, 'nombre', 'descripcion', 'name');
        if (!Number.isFinite(codigo) || !nombre) continue;

        const r = await client.query(
          `INSERT INTO insumo_rubros (business_id, codigo, codigo_maxi, nombre, es_elaborador, activo)
           VALUES ($1, $2, $2, $3, false, true)
           ON CONFLICT (business_id, codigo) DO UPDATE SET
             nombre = EXCLUDED.nombre,
             activo = true,
             updated_at = NOW()
           RETURNING (xmax = 0) AS inserted`,
          [businessId, codigo, nombre.trim()]
        );

        if (r.rows[0]?.inserted) rubrosInserted++;
        else rubrosUpdated++;
      }
    }

    // ── 2. INSUMOS ──
    const insumosRows = parseFile(fileInsumos);
    let insumosInserted = 0, insumosUpdated = 0, insumosSkipped = 0;

    for (const row of insumosRows) {
      const codigo = getCol(row, 'codigo', 'cod', 'sku', 'id');
      const nombre = getCol(row, 'nombre', 'descripcion', 'name');
      if (!nombre) { insumosSkipped++; continue; }

      const codRui = getCol(row, 'cod_rui', 'codrui', 'cod_ru', 'rubro_codigo', 'codigo_rubro');
      const unidadMed = getCol(row, 'unidad_med', 'unidadmed', 'unidad', 'medida', 'um');
      const precio = getCol(row, 'precio', 'precio_ref', 'precioref', 'p_prom');

      // El rubro se guarda como STRING del código (convención actual del proyecto)
      // El JOIN con insumo_rubros lo resuelve por ir.codigo::text = i.rubro
      const rubroVal = codRui && codRui !== '0' ? String(codRui).trim() : null;
      const precioNum = precio != null && Number.isFinite(Number(precio)) ? Number(precio) : null;

      if (codigo) {
        const r = await client.query(
          `INSERT INTO insumos
             (business_id, codigo_maxi, nombre, unidad_med, precio_ref, rubro,
              origen, estado, upload_batch_id, sin_equivalencia, es_elaborado)
           VALUES ($1, $2, $3, $4, $5, $6, 'csv', 'activo', $7, false, false)
           ON CONFLICT (business_id, codigo_maxi) DO UPDATE SET
             nombre = EXCLUDED.nombre,
             unidad_med = COALESCE(EXCLUDED.unidad_med, insumos.unidad_med),
             precio_ref = COALESCE(EXCLUDED.precio_ref, insumos.precio_ref),
             rubro = COALESCE(EXCLUDED.rubro, insumos.rubro),
             upload_batch_id = EXCLUDED.upload_batch_id,
             sin_equivalencia = false,
             updated_at = NOW()
           RETURNING (xmax = 0) AS inserted`,
          [businessId, String(codigo).trim(), nombre.trim(),
            unidadMed?.trim() || null, precioNum, rubroVal, batchId]
        );
        if (r.rows[0]?.inserted) insumosInserted++;
        else insumosUpdated++;
      } else {
        // Sin código → solo insertar si no existe por nombre
        const ex = await client.query(
          `SELECT id FROM insumos WHERE business_id = $1 AND lower(trim(nombre)) = lower($2) LIMIT 1`,
          [businessId, nombre.trim()]
        );
        if (ex.rows.length) { insumosUpdated++; continue; }
        await client.query(
          `INSERT INTO insumos
             (business_id, nombre, unidad_med, precio_ref, rubro,
              origen, estado, upload_batch_id, sin_equivalencia, es_elaborado)
           VALUES ($1, $2, $3, $4, $5, 'csv', 'activo', $6, true, false)`,
          [businessId, nombre.trim(), unidadMed?.trim() || null, precioNum, rubroVal, batchId]
        );
        insumosInserted++;
      }
    }

    await client.query('COMMIT');

    const { invalidateCacheForBiz } = require('../middleware/cacheJson');
    invalidateCacheForBiz(businessId);

    return res.json({
      ok: true,
      batchId,
      rubros: { inserted: rubrosInserted, updated: rubrosUpdated },
      insumos: {
        inserted: insumosInserted,
        updated: insumosUpdated,
        skipped: insumosSkipped,
        total: insumosInserted + insumosUpdated + insumosSkipped,
      },
      summary: {
        inserted: insumosInserted,
        updated: insumosUpdated,
        skipped: insumosSkipped,
      },
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => { });
    console.error('importCsvPaired error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

exports.renombrarRubro = async (req, res, next) => {
  const businessId = getBusinessId(req);
  const oldName = String(req.body?.old ?? '').trim();
  const newName = String(req.body?.new ?? '').trim();
  const codigo = req.body?.codigo != null ? Number(req.body.codigo) : null;

  if (!businessId || !oldName || !newName) {
    return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
  }
  if (oldName === newName) {
    return res.json({ ok: true, message: 'Sin cambios' });
  }

  try {
    // 1. Intentar UPDATE por nombre (caso normal: el rubro existe en el catálogo)
    let { rowCount } = await pool.query(
      `UPDATE insumo_rubros SET nombre = $1, updated_at = NOW()
        WHERE business_id = $2 AND nombre = $3`,
      [newName, businessId, oldName]
    );

    // 2. Si no encontró (rubro huérfano), insertar usando el código provisto
    if (!rowCount && Number.isFinite(codigo)) {
      // ¿Ya existe una entrada para ese código? (renombrar)
      const existing = await pool.query(
        `SELECT id FROM insumo_rubros WHERE business_id = $1 AND codigo = $2`,
        [businessId, codigo]
      );
      if (existing.rowCount) {
        const upd = await pool.query(
          `UPDATE insumo_rubros SET nombre = $1, updated_at = NOW()
            WHERE business_id = $2 AND codigo = $3`,
          [newName, businessId, codigo]
        );
        rowCount = upd.rowCount;
      } else {
        // No existe — crear la entrada con el código y nombre nuevo
        await pool.query(
          `INSERT INTO insumo_rubros (business_id, codigo, codigo_maxi, nombre)
           VALUES ($1, $2, $2, $3)`,
          [businessId, codigo, newName]
        );
        rowCount = 1;
      }
    }

    if (!rowCount) {
      return res.status(404).json({ ok: false, error: 'Rubro no encontrado' });
    }

    const { invalidateCacheForBiz } = require('../middleware/cacheJson');
    invalidateCacheForBiz(businessId);

    return res.json({ ok: true, rubros_updated: rowCount });
  } catch (e) {
    console.error('[renombrarRubroInsumo]', e.message);
    next(e);
  }
};

// GET /businesses/:businessId/insumos/search-padrino?q=texto
// Busca insumos candidatos para usar como referencia (padrino) en el alta manual.
exports.searchPadrinoInsumo = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const q = String(req.query.q || '').trim();
    if (!bizId) return res.status(400).json({ ok: false, error: 'Negocio requerido' });
    if (q.length < 2) return res.json({ ok: true, candidatos: [] });

    const { rows } = await pool.query(
      `SELECT DISTINCT ON (i.id)
              i.id, i.nombre, i.unidad_med, i.precio_ref,
              i.codigo_maxi AS sku,
              COALESCE(ir.nombre, i.rubro) AS rubro,
              g.id     AS agrupacion_id,
              g.nombre AS agrupacion_nombre
         FROM insumos i
         LEFT JOIN insumo_rubros ir
                ON ir.business_id = i.business_id
               AND ir.codigo::text = i.rubro
         LEFT JOIN insumo_group_items gi ON gi.insumo_id = i.id
         LEFT JOIN insumo_groups g       ON g.id = gi.group_id
        WHERE i.business_id = $1
          AND i.estado = 'activo'
          AND i.nombre ILIKE $2
        ORDER BY
          i.id,
          CASE WHEN i.nombre ILIKE $3 THEN 0 ELSE 1 END,
          LENGTH(i.nombre), i.nombre
        LIMIT 15`,
      [bizId, `%${q}%`, `${q}%`]
    );
    const candidatos = rows.map(r => ({
      id: Number(r.id),
      nombre: r.nombre,
      rubro: r.rubro || null,
      unidad_med: r.unidad_med || 'u',
      precio_ref: Number(r.precio_ref) || 0,
      precio: Number(r.precio_ref) || 0,          // el front lee padrino.precio
      sku: r.sku || null,
      agrupacion_id: r.agrupacion_id ? Number(r.agrupacion_id) : null,
      agrupacion_nombre: r.agrupacion_nombre || null,
    }));
    return res.json({ ok: true, candidatos });
  } catch (e) {
    console.error('searchPadrinoInsumo error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// DELETE /insumos/:id/manual — borrado REAL, solo para insumos origen='manual'
exports.eliminarManual = async (req, res) => {
  try {
    const { id } = req.params;
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }
    // Verificar que sea manual antes de borrar
    const { rows } = await pool.query(
      `SELECT origen FROM insumos WHERE id = $1 AND business_id = $2`,
      [id, businessId]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }
    if (rows[0].origen !== 'manual') {
      return res.status(400).json({ ok: false, error: 'Solo se pueden eliminar insumos creados manualmente' });
    }
    // Borrado real. insumo_group_items, receta_items, etc. se limpian por FK CASCADE/SET NULL
    await pool.query(
      `DELETE FROM insumos WHERE id = $1 AND business_id = $2`,
      [id, businessId]
    );
    const { invalidateCacheForBiz } = require('../middleware/cacheJson');
    invalidateCacheForBiz(businessId);
    return res.json({ ok: true, deleted: Number(id) });
  } catch (e) {
    console.error('eliminarManual error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ===================== EQUIVALENCIAS =====================
// Verifica que el insumo pertenezca al negocio activo
async function assertInsumoBiz(insumoId, bizId) {
  // El insumo es global por organización: validar que pertenezca a cualquier
  // negocio de la misma org que el negocio activo (no solo al negocio exacto).
  const { rows } = await pool.query(
    `SELECT 1 FROM insumos i
       WHERE i.id = $1
         AND i.business_id = ANY(
           SELECT id FROM app_businesses
            WHERE organization_id = (SELECT organization_id FROM app_businesses WHERE id = $2)
         )`,
    [insumoId, bizId]
  );
  return rows.length > 0;
}

// GET /insumos/:id/equivalencias
exports.equivalencias_list = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const insumoId = Number(req.params.id);
    if (!bizId) return res.status(400).json({ ok: false, error: 'Negocio requerido' });
    if (!Number.isFinite(insumoId)) return res.status(400).json({ ok: false, error: 'ID inválido' });
    if (!(await assertInsumoBiz(insumoId, bizId))) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }
    const { rows } = await pool.query(
      `SELECT id, insumo_id, nombre, contenido, unidad, created_at, updated_at
         FROM insumo_equivalencias
        WHERE insumo_id = $1
        ORDER BY nombre ASC`,
      [insumoId]
    );
    return res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('equivalencias_list error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /insumos/:id/equivalencias
exports.equivalencias_create = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const insumoId = Number(req.params.id);
    const { nombre, contenido, unidad } = req.body || {};
    if (!bizId) return res.status(400).json({ ok: false, error: 'Negocio requerido' });
    if (!Number.isFinite(insumoId)) return res.status(400).json({ ok: false, error: 'ID inválido' });
    if (!nombre?.trim()) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
    if (!(Number(contenido) > 0)) return res.status(400).json({ ok: false, error: 'Contenido debe ser mayor a 0' });
    if (!unidad?.trim()) return res.status(400).json({ ok: false, error: 'Unidad requerida' });
    if (!(await assertInsumoBiz(insumoId, bizId))) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }
    const { rows } = await pool.query(
      `INSERT INTO insumo_equivalencias (insumo_id, nombre, contenido, unidad)
       VALUES ($1, $2, $3, $4)
       RETURNING id, insumo_id, nombre, contenido, unidad, created_at, updated_at`,
      [insumoId, nombre.trim(), Number(contenido), unidad.trim()]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'Ya existe una equivalencia con ese nombre' });
    console.error('equivalencias_create error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// PUT /insumos/:id/equivalencias/:eqId
exports.equivalencias_update = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const insumoId = Number(req.params.id);
    const eqId = Number(req.params.eqId);
    const { nombre, contenido, unidad } = req.body || {};
    if (!bizId) return res.status(400).json({ ok: false, error: 'Negocio requerido' });
    if (!Number.isFinite(insumoId) || !Number.isFinite(eqId)) {
      return res.status(400).json({ ok: false, error: 'ID inválido' });
    }
    if (!(await assertInsumoBiz(insumoId, bizId))) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }
    const sets = [];
    const vals = [];
    if (nombre !== undefined) { vals.push(nombre.trim()); sets.push(`nombre = $${vals.length}`); }
    if (contenido !== undefined) { vals.push(Number(contenido)); sets.push(`contenido = $${vals.length}`); }
    if (unidad !== undefined) { vals.push(unidad.trim()); sets.push(`unidad = $${vals.length}`); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(eqId, insumoId);
    const { rows } = await pool.query(
      `UPDATE insumo_equivalencias SET ${sets.join(', ')}
        WHERE id = $${vals.length - 1} AND insumo_id = $${vals.length}
        RETURNING id, insumo_id, nombre, contenido, unidad, created_at, updated_at`,
      vals
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Equivalencia no encontrada' });
    return res.json({ ok: true, data: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'Ya existe una equivalencia con ese nombre' });
    console.error('equivalencias_update error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// DELETE /insumos/:id/equivalencias/:eqId
exports.equivalencias_remove = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const insumoId = Number(req.params.id);
    const eqId = Number(req.params.eqId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'Negocio requerido' });
    if (!Number.isFinite(insumoId) || !Number.isFinite(eqId)) {
      return res.status(400).json({ ok: false, error: 'ID inválido' });
    }
    if (!(await assertInsumoBiz(insumoId, bizId))) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM insumo_equivalencias WHERE id = $1 AND insumo_id = $2`,
      [eqId, insumoId]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: 'Equivalencia no encontrada' });
    return res.json({ ok: true, deleted: eqId });
  } catch (e) {
    console.error('equivalencias_remove error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ===================== MERMAS =====================
// GET /insumos/:id/mermas
exports.mermas_list = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const insumoId = Number(req.params.id);
    if (!bizId) return res.status(400).json({ ok: false, error: 'Negocio requerido' });
    if (!Number.isFinite(insumoId)) return res.status(400).json({ ok: false, error: 'ID inválido' });
    if (!(await assertInsumoBiz(insumoId, bizId))) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }
    const { rows } = await pool.query(
      `SELECT id, insumo_id, nombre, peso_inicial, peso_final, es_default, created_at, updated_at
         FROM insumo_mermas
        WHERE insumo_id = $1
        ORDER BY es_default DESC, nombre ASC`,
      [insumoId]
    );
    return res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('mermas_list error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /insumos/:id/mermas
exports.mermas_create = async (req, res) => {
  const client = await pool.connect();
  try {
    const bizId = getBusinessId(req);
    const insumoId = Number(req.params.id);
    const { nombre, peso_inicial, peso_final, es_default } = req.body || {};
    if (!bizId) return res.status(400).json({ ok: false, error: 'Negocio requerido' });
    if (!Number.isFinite(insumoId)) return res.status(400).json({ ok: false, error: 'ID inválido' });
    if (!nombre?.trim()) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
    if (!(Number(peso_inicial) > 0) || !(Number(peso_final) > 0)) {
      return res.status(400).json({ ok: false, error: 'Pesos deben ser mayores a 0' });
    }
    if (!(await assertInsumoBiz(insumoId, bizId))) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }
    await client.query('BEGIN');
    // Si esta merma es default, desmarcar las otras
    if (es_default === true) {
      await client.query(`UPDATE insumo_mermas SET es_default = FALSE WHERE insumo_id = $1`, [insumoId]);
    }
    const { rows } = await client.query(
      `INSERT INTO insumo_mermas (insumo_id, nombre, peso_inicial, peso_final, es_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, insumo_id, nombre, peso_inicial, peso_final, es_default, created_at, updated_at`,
      [insumoId, nombre.trim(), Number(peso_inicial), Number(peso_final), es_default === true]
    );
    await client.query('COMMIT');
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'Ya existe una merma con ese nombre' });
    console.error('mermas_create error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

// PUT /insumos/:id/mermas/:mermaId
exports.mermas_update = async (req, res) => {
  const client = await pool.connect();
  try {
    const bizId = getBusinessId(req);
    const insumoId = Number(req.params.id);
    const mermaId = Number(req.params.mermaId);
    const { nombre, peso_inicial, peso_final, es_default } = req.body || {};
    if (!bizId) return res.status(400).json({ ok: false, error: 'Negocio requerido' });
    if (!Number.isFinite(insumoId) || !Number.isFinite(mermaId)) {
      return res.status(400).json({ ok: false, error: 'ID inválido' });
    }
    if (!(await assertInsumoBiz(insumoId, bizId))) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }
    await client.query('BEGIN');
    if (es_default === true) {
      await client.query(`UPDATE insumo_mermas SET es_default = FALSE WHERE insumo_id = $1`, [insumoId]);
    }
    const sets = [];
    const vals = [];
    if (nombre !== undefined) { vals.push(nombre.trim()); sets.push(`nombre = $${vals.length}`); }
    if (peso_inicial !== undefined) { vals.push(Number(peso_inicial)); sets.push(`peso_inicial = $${vals.length}`); }
    if (peso_final !== undefined) { vals.push(Number(peso_final)); sets.push(`peso_final = $${vals.length}`); }
    if (es_default !== undefined) { vals.push(es_default === true); sets.push(`es_default = $${vals.length}`); }
    if (!sets.length) { await client.query('COMMIT'); return res.json({ ok: true }); }
    vals.push(mermaId, insumoId);
    const { rows } = await client.query(
      `UPDATE insumo_mermas SET ${sets.join(', ')}
        WHERE id = $${vals.length - 1} AND insumo_id = $${vals.length}
        RETURNING id, insumo_id, nombre, peso_inicial, peso_final, es_default, created_at, updated_at`,
      vals
    );
    await client.query('COMMIT');
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Merma no encontrada' });
    return res.json({ ok: true, data: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ ok: false, error: 'Ya existe una merma con ese nombre' });
    console.error('mermas_update error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

// DELETE /insumos/:id/mermas/:mermaId
exports.mermas_remove = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const insumoId = Number(req.params.id);
    const mermaId = Number(req.params.mermaId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'Negocio requerido' });
    if (!Number.isFinite(insumoId) || !Number.isFinite(mermaId)) {
      return res.status(400).json({ ok: false, error: 'ID inválido' });
    }
    if (!(await assertInsumoBiz(insumoId, bizId))) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM insumo_mermas WHERE id = $1 AND insumo_id = $2`,
      [mermaId, insumoId]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: 'Merma no encontrada' });
    return res.json({ ok: true, deleted: mermaId });
  } catch (e) {
    console.error('mermas_remove error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// PUT /insumos/:id/desperdicio-override
// Body: { pct: number | null }  (null = usar el global de config)
exports.setDesperdicioOverride = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const insumoId = Number(req.params.id);
    const { pct } = req.body || {};
    if (!bizId) return res.status(400).json({ ok: false, error: 'Negocio requerido' });
    if (!Number.isFinite(insumoId)) return res.status(400).json({ ok: false, error: 'ID inválido' });
    if (!(await assertInsumoBiz(insumoId, bizId))) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }
    const val = pct == null || pct === '' ? null : Number(pct);
    if (val != null && (!Number.isFinite(val) || val < 0)) {
      return res.status(400).json({ ok: false, error: 'Porcentaje inválido' });
    }
    await pool.query(
      `UPDATE insumos SET desperdicio_pct_override = $1, updated_at = NOW() WHERE id = $2`,
      [val, insumoId]
    );
    return res.json({ ok: true, desperdicio_pct_override: val });
  } catch (e) {
    console.error('setDesperdicioOverride error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// GET /insumos/:id/reemplazar-preview  → cuántas recetas usan este insumo
exports.reemplazarPreview = async (req, res) => {
  try {
    const bizId = getBusinessId(req);
    const insumoId = Number(req.params.id);
    if (!bizId) return res.status(400).json({ ok: false, error: 'Negocio requerido' });
    if (!Number.isFinite(insumoId)) return res.status(400).json({ ok: false, error: 'ID inválido' });
    if (!(await assertInsumoBiz(insumoId, bizId))) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT r.id) AS recetas,
              COUNT(ri.id) AS items,
              COUNT(DISTINCT r.business_id) AS negocios
         FROM receta_items ri
         JOIN recetas r ON r.id = ri.receta_id
        WHERE ri.insumo_id = $1
          AND r.business_id = ANY(
                SELECT id FROM app_businesses
                 WHERE organization_id = (SELECT organization_id FROM app_businesses WHERE id = $2)
              )
          AND r.active = TRUE`,
      [insumoId, bizId]
    );
    return res.json({
      ok: true,
      recetas: Number(rows[0].recetas),
      items: Number(rows[0].items),
      negocios: Number(rows[0].negocios),
    });
  } catch (e) {
    console.error('reemplazarPreview error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// POST /insumos/:id/reemplazar  body { nuevoInsumoId }
// Reemplaza el insumo viejo por el nuevo en todas las recetas del negocio activo.
exports.reemplazarInsumo = async (req, res) => {
  const client = await pool.connect();
  try {
    const bizId = getBusinessId(req);
    const viejoId = Number(req.params.id);
    const nuevoId = Number(req.body?.nuevoInsumoId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'Negocio requerido' });
    if (!Number.isFinite(viejoId) || !Number.isFinite(nuevoId)) {
      return res.status(400).json({ ok: false, error: 'IDs inválidos' });
    }
    if (viejoId === nuevoId) {
      return res.status(400).json({ ok: false, error: 'El insumo nuevo debe ser distinto del viejo' });
    }
    // Ambos insumos deben pertenecer al negocio
    if (!(await assertInsumoBiz(viejoId, bizId))) {
      return res.status(404).json({ ok: false, error: 'Insumo a reemplazar no encontrado' });
    }
    if (!(await assertInsumoBiz(nuevoId, bizId))) {
      return res.status(404).json({ ok: false, error: 'Insumo nuevo no encontrado' });
    }

    await client.query('BEGIN');

    // Datos del insumo nuevo (precio y unidad base) para recalcular costo_unitario
    const { rows: nuevoRows } = await client.query(
      `SELECT id, precio_ref, unidad_med FROM insumos WHERE id = $1`, [nuevoId]
    );
    const precioNuevo = Number(nuevoRows[0]?.precio_ref) || 0;
    const unidadBaseNuevo = String(nuevoRows[0]?.unidad_med || 'u').toLowerCase().trim();

    // Merma default del insumo nuevo (si tiene)
    const { rows: mermaRows } = await client.query(
      `SELECT id FROM insumo_mermas WHERE insumo_id = $1 AND es_default = TRUE LIMIT 1`, [nuevoId]
    );
    const mermaDefaultId = mermaRows[0]?.id || null;

    // Negocios de la organización del negocio activo (reemplazo a nivel org)
    const { rows: orgBiz } = await client.query(
      `SELECT id FROM app_businesses
        WHERE organization_id = (SELECT organization_id FROM app_businesses WHERE id = $1)`,
      [bizId]
    );
    const bizIds = orgBiz.map(b => b.id);
    // Fallback: si no hay org, al menos el negocio activo
    const negocios = bizIds.length ? bizIds : [bizId];

    // Recetas de TODOS los negocios de la org donde aparece el insumo viejo
    const { rows: itemsAfectados } = await client.query(
      `SELECT ri.id, ri.receta_id, ri.cantidad, ri.unidad, r.business_id
         FROM receta_items ri
         JOIN recetas r ON r.id = ri.receta_id
        WHERE ri.insumo_id = $1 AND r.business_id = ANY($2) AND r.active = TRUE`,
      [viejoId, negocios]
    );

    if (itemsAfectados.length === 0) {
      await client.query('COMMIT');
      return res.json({ ok: true, recetasAfectadas: 0, itemsAfectados: 0 });
    }

    // Reemplazar en cada item: insumo_id nuevo, costo_unitario recalculado, merma default del nuevo
    for (const it of itemsAfectados) {
      // Convertir el precio del nuevo insumo (en su unidad base) a la unidad del item
      const unidadItem = String(it.unidad || unidadBaseNuevo || 'u').toLowerCase().trim();
      const factor = factorConversion(unidadBaseNuevo, unidadItem);
      const costoUnit = factor > 0 ? precioNuevo / factor : precioNuevo;
      await client.query(
        `UPDATE receta_items
            SET insumo_id = $1, costo_unitario = $2, merma_id = $3, updated_at = NOW()
          WHERE id = $4`,
        [nuevoId, Number(costoUnit.toFixed(4)), mermaDefaultId, it.id]
      );
    }

    // Recalcular costo_total de las recetas afectadas (SUM de cantidad × costo_unitario)
    const recetaIds = [...new Set(itemsAfectados.map(it => it.receta_id))];
    await recalcularCostoRecetas(recetaIds, client);

    await client.query('COMMIT');
    return res.json({
      ok: true,
      recetasAfectadas: recetaIds.length,
      itemsAfectados: itemsAfectados.length,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('reemplazarInsumo error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};