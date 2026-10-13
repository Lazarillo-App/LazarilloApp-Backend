// controllers/purchasesController.js
'use strict';

const pool = require('../config/db');
const getBusinessId = require('../utils/getBusinessId');
const { fetchMaxiSuppliers, fetchMaxiPurchases } = require('../services/maxiPurchasesService');
const { upsertPurchasesBatch, upsertSuppliers } = require('../services/purchasesStore');

// ── Credenciales / proveedores siempre del principal de la org ──
// Modelo de alcances Lazarillo:
//   - COMPRAS (purchases/purchase_items): por-negocio → se usa el bizId crudo.
//   - PROVEEDORES (suppliers): org-wide → viven en el principal, se resuelven con esta función.
//   - INSUMOS: org-wide → también en el principal.
async function resolveCredsBizId(bizId) {
  const { rows } = await pool.query(
    'SELECT created_from, organization_id FROM app_businesses WHERE id = $1',
    [bizId]
  );
  const biz = rows[0];
  if (!biz || biz.created_from !== 'from_group' || !biz.organization_id) return bizId;
  const { rows: rootRows } = await pool.query(
    `SELECT id FROM app_businesses
      WHERE organization_id = $1
        AND (created_from IS NULL OR created_from = 'manual' OR created_from = 'onboarding')
      ORDER BY id ASC LIMIT 1`,
    [biz.organization_id]
  );
  return rootRows[0]?.id ?? bizId;
}

// Proveedores viven en el principal (org-wide). Alias semántico de resolveCredsBizId.
async function resolveSupplierBizId(bizId) {
  return resolveCredsBizId(bizId);
}

// ── Mapa codigo_maxi → insumo_id ──
async function buildInsumoMap(businessId) {
  const { rows } = await pool.query(
    `SELECT id, codigo_maxi::bigint AS codigo_maxi
       FROM insumos
      WHERE business_id = $1
        AND codigo_maxi IS NOT NULL
        AND codigo_maxi ~ '^[0-9]+$'`,
    [businessId]
  );
  const map = new Map();
  for (const r of rows) {
    if (r.codigo_maxi != null) map.set(Number(r.codigo_maxi), Number(r.id));
  }
  return map;
}

// ── Helper: construye cláusulas WHERE reutilizables para compras ──
// Devuelve { where: string[], params: any[] } listo para interpolación segura.
// El caller ya pone business_id como $1 antes de llamar a este helper.
function buildPurchaseFilters(query, startIndex = 2) {
  const { from, to, proveedor_id, insumo_id, insumo_ids, branch_id } = query;
  const where = [];
  const params = [];
  let idx = startIndex;

  if (from) {
    params.push(from);
    where.push(`pi.fecha >= $${idx++}`);
  }
  if (to) {
    params.push(to);
    where.push(`pi.fecha <= $${idx++}`);
  }
  if (proveedor_id) {
    params.push(Number(proveedor_id));
    where.push(`p.proveedor_id = $${idx++}`);
  }
  // insumo_ids tiene prioridad sobre insumo_id (array vs singular)
  if (insumo_ids) {
    const ids = String(insumo_ids).split(',').map(Number).filter(n => Number.isFinite(n) && n > 0);
    if (ids.length > 0) {
      params.push(ids);
      where.push(`pi.insumo_id = ANY($${idx++}::int[])`);
    }
  } else if (insumo_id) {
    params.push(Number(insumo_id));
    where.push(`pi.insumo_id = $${idx++}`);
  }
  // branch_id = 'all' o ausente → sin filtro (muestra todas las sucursales)
  // branch_id = número         → filtra por esa sucursal
  // branch_id = 'none'         → solo compras sin sucursal asignada
  if (branch_id && branch_id !== 'all') {
    if (branch_id === 'none') {
      where.push(`p.branch_id IS NULL`);
    } else {
      params.push(Number(branch_id));
      where.push(`p.branch_id = $${idx++}`);
    }
  }
  return { where, params };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/purchases/sync  { from, to, provdr?, num?, branch_id? }
// ─────────────────────────────────────────────────────────────────────────────
exports.sync = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    if (!rawBizId) return res.status(400).json({ ok: false, error: 'business_id requerido' });

    const businessId = rawBizId;
    const credsBizId = await resolveCredsBizId(rawBizId);

    const { from, to, provdr, num, branch_id } = req.body;
    if (!from || !to) return res.status(400).json({ ok: false, error: 'from y to son requeridos' });

    // Validar branch_id si viene: debe pertenecer al negocio
    if (branch_id) {
      const { rows: branchCheck } = await pool.query(
        'SELECT id FROM app_branches WHERE id = $1 AND business_id = $2',
        [branch_id, businessId]
      );
      if (!branchCheck.length) {
        return res.status(400).json({ ok: false, error: 'Sucursal no válida para este negocio' });
      }
    }

    // 1) Proveedores → se upsertean en el PRINCIPAL (org-wide)
    let suppliersCount = 0;
    try {
      const proveedores = await fetchMaxiSuppliers({ businessId: credsBizId, req });
      suppliersCount = await upsertSuppliers(credsBizId, proveedores);
    } catch (e) {
      console.warn('[purchases.sync] Proveedores falló (no crítico):', e.message);
    }

    // 2) Compras → se guardan en el negocio activo (por-negocio)
    const facturas = await fetchMaxiPurchases({ businessId: credsBizId, req, from, to, provdr, num });
    if (!facturas.length) {
      return res.json({ ok: true, inserted: 0, updated: 0, items: 0, suppliers: suppliersCount, message: 'Sin compras en el rango' });
    }

    // 3) Cruzar con insumos (del principal)
    const insumoMap = await buildInsumoMap(credsBizId);

    // 4) Upsert — pasa branch_id para que se guarde en purchases
    const result = await upsertPurchasesBatch(businessId, facturas, insumoMap, branch_id ?? null);
    res.json({ ok: true, ...result, suppliers: suppliersCount });
  } catch (e) {
    console.error('[purchases.sync] error:', e);
    next(e);
  }
};

// POST /api/purchases/sync-suppliers
// Proveedores org-wide → se upsertean SIEMPRE en el principal de la org.
exports.syncSuppliers = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    const credsBizId = await resolveCredsBizId(rawBizId);
    const proveedores = await fetchMaxiSuppliers({ businessId: credsBizId, req });
    const count = await upsertSuppliers(credsBizId, proveedores);
    res.json({ ok: true, suppliers: count });
  } catch (e) { next(e); }
};

// GET /api/purchases/suppliers
// Proveedores org-wide → se listan desde el principal de la org.
exports.listSuppliers = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    const supplierBizId = await resolveSupplierBizId(rawBizId);
    const { rows } = await pool.query(
      'SELECT id, nombre, razon_social, cuit FROM suppliers WHERE business_id = $1 ORDER BY nombre ASC',
      [supplierBizId]
    );
    res.json({ ok: true, data: rows });
  } catch (e) { next(e); }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/purchases?from=&to=&proveedor_id=&insumo_id=&branch_id=&page=&limit=
//
// branch_id = número  → filtra esa sucursal
// branch_id = 'all'   → todas las sucursales (default, igual que antes)
// branch_id = 'none'  → compras sin sucursal asignada
//
// Nuevas columnas en la respuesta:
//   branch_id, branch_name, branch_color  (null si no tiene sucursal)
//
// Alcances: las COMPRAS se filtran por el negocio activo (crudo); los PROVEEDORES
// se resuelven contra el principal de la org (org-wide).
// ─────────────────────────────────────────────────────────────────────────────
exports.list = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    if (!rawBizId) return res.status(400).json({ ok: false, error: 'business_id requerido' });

    const businessId = rawBizId;                              // compras: por-negocio
    const supplierBizId = await resolveSupplierBizId(rawBizId); // proveedores: principal

    const { page = 1, limit = 500 } = req.query;
    const hardLimit = Math.min(Math.max(Number(limit), 1), 10000);
    const offset = (Math.max(Number(page), 1) - 1) * hardLimit;

    const baseParams = [businessId];
    const baseWhere = ['pi.business_id = $1'];
    const { where: extraWhere, params: extraParams } = buildPurchaseFilters(req.query, 2);

    const allWhere = [...baseWhere, ...extraWhere];
    const allParams = [...baseParams, ...extraParams];
    const whereSql = 'WHERE ' + allWhere.join(' AND ');

    // El JOIN de suppliers resuelve contra el principal (org-wide), no contra p.business_id.
    // supplierBizId va como parámetro posicional después de los del WHERE.
    const supplierParamIdx = allParams.length + 1;

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT
           pi.id, pi.fecha,
           pi.insumo_id,
           p.id                  AS purchase_id,
           p.factura_key         AS factura,
           p.branch_id,
           ab.name               AS branch_name,
           ab.color              AS branch_color,
           s.nombre              AS proveedor_nombre,
           s.cuit                AS proveedor_cuit,
           i.nombre              AS insumo_nombre,
           i.unidad_med, i.codigo_maxi,
           pi.cantidad, pi.precio, pi.precio_total,
           pi.iva_tasa, pi.iva,
           pi.iva_total_item     AS iva_total,
           pi.neto, pi.imp_int, pi.imp_int_total,
           pi.orden_compra, pi.referencia
         FROM purchase_items pi
         JOIN purchases p        ON p.id = pi.purchase_id
         LEFT JOIN app_branches ab ON ab.id = p.branch_id
         LEFT JOIN suppliers s   ON s.id = p.proveedor_id AND s.business_id = $${supplierParamIdx}
         LEFT JOIN insumos   i   ON i.id = pi.insumo_id
         ${whereSql}
         ORDER BY pi.fecha DESC, p.factura_key, pi.id
         LIMIT $${allParams.length + 2}
         OFFSET $${allParams.length + 3}`,
        [...allParams, supplierBizId, hardLimit, offset]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT pi.id)::int AS total
           FROM purchase_items pi
           JOIN purchases p ON p.id = pi.purchase_id
           LEFT JOIN app_branches ab ON ab.id = p.branch_id
           ${whereSql}`,
        allParams
      ),
    ]);

    res.json({
      ok: true,
      data: dataRes.rows,
      pagination: { page: Number(page), limit: hardLimit, total: countRes.rows[0].total },
    });
  } catch (e) {
    console.error('[purchases.list] error:', e);
    next(e);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/purchases/ranking?from=&to=&branch_id=&pin=&limit=20
// Ranking de insumos por gasto total en el período — para el chip "Top N por
// gasto" del detalle de compras (ComprasMiniDetalleModal.jsx). Devuelve los
// primeros `limit` (default 20) más, si `pin` (el insumo que se está viendo)
// queda afuera de ese corte, su fila también — con su rank REAL sobre el
// total de insumos, no sobre el top. total_insumos/total_gasto vienen en
// cada fila (window function) para no pegarle dos veces a la base.
// ─────────────────────────────────────────────────────────────────────────────
exports.ranking = async (req, res, next) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return res.status(400).json({ ok: false, error: 'business_id requerido' });

    const { from, to, branch_id: rawBranchId, pin, limit: rawLimit } = req.query;
    if (!from || !to) {
      return res.status(400).json({ ok: false, error: 'from y to son requeridos (YYYY-MM-DD)' });
    }

    const limit = Math.min(Math.max(Number(rawLimit) || 20, 1), 100);
    const pinId = Number(pin) || null;

    const params = [businessId, from, to];
    let branchFilter = '';
    if (rawBranchId === 'none') {
      branchFilter = 'AND p.branch_id IS NULL';
    } else if (rawBranchId && rawBranchId !== 'all' && rawBranchId !== '') {
      const bid = Number(rawBranchId);
      if (Number.isFinite(bid) && bid > 0) {
        params.push(bid);
        branchFilter = `AND p.branch_id = $${params.length}`;
      }
    }

    params.push(limit);
    const limitIdx = params.length;
    let pinClause = '';
    if (pinId) {
      params.push(pinId);
      pinClause = `OR r.id = $${params.length}`;
    }

    const { rows } = await pool.query(
      `WITH totals AS (
         SELECT pi.insumo_id AS id,
                SUM(pi.precio_total + COALESCE(pi.iva_total_item, 0))::numeric AS total
           FROM purchase_items pi
           JOIN purchases p ON p.id = pi.purchase_id
          WHERE pi.business_id = $1 AND pi.fecha BETWEEN $2::date AND $3::date
            ${branchFilter}
          GROUP BY pi.insumo_id
         HAVING SUM(pi.precio_total + COALESCE(pi.iva_total_item, 0)) > 0
       ),
       ranked AS (
         SELECT id, total,
                RANK() OVER (ORDER BY total DESC)::int AS rank,
                COUNT(*) OVER ()::int AS total_insumos,
                SUM(total) OVER ()::numeric AS total_gasto
           FROM totals
       )
       SELECT r.id, r.total, r.rank, r.total_insumos, r.total_gasto,
              i.nombre, i.codigo_mostrar, i.codigo_maxi, i.unidad_med
         FROM ranked r
         JOIN insumos i ON i.id = r.id
        WHERE r.rank <= $${limitIdx} ${pinClause}
        ORDER BY r.rank ASC`,
      params
    );

    const totalInsumos = rows[0] ? Number(rows[0].total_insumos) : 0;
    const totalGasto = rows[0] ? Number(rows[0].total_gasto) : 0;

    const items = rows.map(r => ({
      id: String(r.id),
      nombre: r.nombre,
      codigo: r.codigo_mostrar || r.codigo_maxi || null,
      unidad_med: r.unidad_med || 'u',
      total: Number(r.total) || 0,
      rank: Number(r.rank),
    }));

    return res.json({ ok: true, total_insumos: totalInsumos, total_gasto: totalGasto, items });
  } catch (e) {
    console.error('[purchases.ranking] error:', e);
    next(e);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/purchases/food-cost?from=&to=&branch_id=
// Compras agregadas POR INSUMO con su rubro y agrupación, para el KPI de Food
// Cost de Gestión de Artículos — ver KpiFoodCost.jsx / kpi-foodcost.schema.json
// (campo "itemCompra": id, nombre, agrupacion, rubro, importe).
// Agrupación: la primera agrupación REAL del insumo (insumo_group_items),
// excluyendo Todo/Sin agrupación/Discontinuados — mismo criterio que ya usa
// el front (esTodoGroup/esDiscontinuadosGroup) para no contar esos grupos
// especiales como clasificación real.
// ─────────────────────────────────────────────────────────────────────────────
exports.foodCost = async (req, res, next) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) return res.status(400).json({ ok: false, error: 'business_id requerido' });

    const baseParams = [businessId];
    const baseWhere = ['pi.business_id = $1'];
    const { where: extraWhere, params: extraParams } = buildPurchaseFilters(req.query, 2);
    const allWhere = [...baseWhere, ...extraWhere];
    const allParams = [...baseParams, ...extraParams];

    const { rows } = await pool.query(
      `SELECT
         i.id,
         i.nombre,
         COALESCE(ag.nombre, 'Sin agrupación') AS agrupacion,
         COALESCE(ir.nombre, NULLIF(i.rubro, ''), 'Sin rubro') AS rubro,
         SUM(pi.precio_total + COALESCE(pi.iva_total_item, 0))::numeric AS importe
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
       JOIN insumos i   ON i.id = pi.insumo_id
       LEFT JOIN insumo_rubros ir
         ON ir.business_id = i.business_id AND ir.codigo::text = i.rubro
       LEFT JOIN LATERAL (
         SELECT ig2.nombre
           FROM insumo_group_items igi2
           JOIN insumo_groups ig2 ON ig2.id = igi2.group_id
          WHERE igi2.insumo_id = i.id
            AND lower(trim(ig2.nombre)) NOT IN
              ('discontinuados', 'descontinuados', 'todo', 'sin agrupacion', 'sin agrupación', 'sin agrupar', 'sin grupo')
          ORDER BY ig2.id ASC
          LIMIT 1
       ) ag ON TRUE
       WHERE ${allWhere.join(' AND ')}
       GROUP BY i.id, i.nombre, ag.nombre, ir.nombre, i.rubro
      HAVING SUM(pi.precio_total + COALESCE(pi.iva_total_item, 0)) <> 0`,
      allParams
    );

    const items = rows.map(r => ({
      id: String(r.id),
      nombre: r.nombre,
      agrupacion: r.agrupacion,
      rubro: r.rubro,
      importe: Number(r.importe) || 0,
    }));

    return res.json({ ok: true, items });
  } catch (e) {
    console.error('[purchases.foodCost] error:', e);
    next(e);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/purchases/summary?from=&to=&branch_id=
// ─────────────────────────────────────────────────────────────────────────────
exports.summary = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    const businessId = rawBizId;                              // compras: por-negocio
    const supplierBizId = await resolveSupplierBizId(rawBizId); // proveedores: principal

    const baseParams = [businessId];
    const { where: extraWhere, params: extraParams } = buildPurchaseFilters(req.query, 2);
    const allParams = [...baseParams, ...extraParams];

    // El summary agrupa por proveedor Y por sucursal cuando no hay filtro específico
    const branchSelect = req.query.branch_id && req.query.branch_id !== 'all'
      ? ''  // ya filtrado, no necesita agrupar por branch
      : `, ab.id AS branch_id, ab.name AS branch_name, ab.color AS branch_color`;

    const branchGroup = req.query.branch_id && req.query.branch_id !== 'all'
      ? ''
      : `, ab.id, ab.name, ab.color`;

    const extraFilterSql = extraWhere.length ? 'AND ' + extraWhere.join(' AND ') : '';

    // supplierBizId como parámetro posicional después de los del WHERE.
    const supplierParamIdx = allParams.length + 1;

    const { rows } = await pool.query(
      `SELECT
           s.id             AS proveedor_id,
           s.nombre         AS proveedor_nombre,
           s.cuit
           ${branchSelect},
           COUNT(DISTINCT p.id)::int       AS facturas,
           SUM(pi.cantidad)::numeric       AS cantidad_total,
           SUM(pi.precio_total)::numeric   AS neto_total,
           SUM(pi.iva_total_item)::numeric AS iva_total,
           SUM(pi.precio_total + COALESCE(pi.iva_total_item,0))::numeric AS total
         FROM purchase_items pi
         JOIN purchases p        ON p.id = pi.purchase_id
         LEFT JOIN app_branches ab ON ab.id = p.branch_id
         LEFT JOIN suppliers s   ON s.id = p.proveedor_id AND s.business_id = $${supplierParamIdx}
         WHERE pi.business_id = $1 ${extraFilterSql}
         GROUP BY s.id, s.nombre, s.cuit${branchGroup}
         ORDER BY total DESC NULLS LAST`,
      [...allParams, supplierBizId]
    );
    res.json({ ok: true, data: rows });
  } catch (e) { next(e); }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/purchases/export/csv?from=&to=&proveedor_id=&insumo_id=&branch_id=
// ─────────────────────────────────────────────────────────────────────────────
exports.exportCsv = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    const businessId = rawBizId;                              // compras: por-negocio
    const supplierBizId = await resolveSupplierBizId(rawBizId); // proveedores: principal

    const baseParams = [businessId];
    const baseWhere = ['pi.business_id = $1'];
    const { where: extraWhere, params: extraParams } = buildPurchaseFilters(req.query, 2);

    const allWhere = [...baseWhere, ...extraWhere];
    const allParams = [...baseParams, ...extraParams];

    // supplierBizId como parámetro posicional después de los del WHERE.
    const supplierParamIdx = allParams.length + 1;

    // Agregado por insumo
    const { rows } = await pool.query(
      `SELECT
           COALESCE(i.codigo_maxi::text, 'INS-' || pi.insumo_id::text) AS codigo,
           COALESCE(MAX(i.nombre), MAX(pi.referencia), 'Insumo #' || pi.insumo_id::text) AS nombre,
           COALESCE(MAX(i.unidad_med), '') AS unidad,
           SUM(pi.cantidad)::numeric        AS cantidad,
           SUM(pi.precio_total)::numeric    AS neto_total,
           SUM(COALESCE(pi.iva_total_item, 0))::numeric AS iva_total,
           SUM(pi.precio_total + COALESCE(pi.iva_total_item, 0))::numeric AS total
         FROM purchase_items pi
         JOIN purchases p        ON p.id = pi.purchase_id
         LEFT JOIN app_branches ab ON ab.id = p.branch_id
         LEFT JOIN suppliers s   ON s.id = p.proveedor_id AND s.business_id = $${supplierParamIdx}
         LEFT JOIN insumos   i   ON i.id = pi.insumo_id
         WHERE ${allWhere.join(' AND ')}
         GROUP BY pi.insumo_id, i.codigo_maxi
         ORDER BY SUM(pi.precio_total + COALESCE(pi.iva_total_item, 0)) DESC NULLS LAST`,
      [...allParams, supplierBizId]
    );

    const headers = ['Código', 'Nombre', 'Unidad', 'Cantidad', 'Precio unitario', 'Total'];
    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(';') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const lines = [
      headers.join(';'),
      ...rows.map((r) => {
        const cantidad = Number(r.cantidad || 0);
        const total = Number(r.total || 0);
        const precioUnit = cantidad > 0 ? (total / cantidad) : 0;

        return [
          esc(r.codigo),
          esc(r.nombre),
          esc(r.unidad),
          cantidad.toFixed(2).replace('.', ','),
          precioUnit.toFixed(2).replace('.', ','),
          total.toFixed(2).replace('.', ','),
        ].join(';');
      }),
    ];

    const { from, to } = req.query;
    const filename = `compras_${from ?? 'all'}_${to ?? 'all'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(lines.join('\r\n'), 'utf8')]));
  } catch (e) {
    console.error('[purchases.exportCsv] error:', e);
    next(e);
  }
};

// GET /api/purchases/first-date
exports.firstDate = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    if (!rawBizId) return res.status(400).json({ ok: false, error: 'business_id requerido' });
    const businessId = rawBizId; // compras: por-negocio

    const { branch_id } = req.query;
    const params = [businessId];
    let branchFilter = '';

    if (branch_id === 'main' || branch_id === 'none') {
      branchFilter = `AND p.branch_id IS NULL`;
    } else if (branch_id && branch_id !== 'all') {
      params.push(Number(branch_id));
      branchFilter = `AND p.branch_id = $2`;
    }

    const { rows } = await pool.query(
      `SELECT MIN(pi.fecha)::date AS first_date
         FROM purchase_items pi
         JOIN purchases p ON p.id = pi.purchase_id
        WHERE pi.business_id = $1 ${branchFilter}`,
      params
    );

    res.json({
      ok: true,
      firstDate: rows[0]?.first_date ? String(rows[0].first_date).slice(0, 10) : null,
    });
  } catch (e) {
    console.error('[purchases.firstDate] error:', e);
    next(e);
  }
};