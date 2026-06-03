// controllers/purchasesController.js
'use strict';

const pool = require('../config/db');
const getBusinessId = require('../utils/getBusinessId');
const { fetchMaxiSuppliers, fetchMaxiPurchases } = require('../services/maxiPurchasesService');
const { upsertPurchasesBatch, upsertSuppliers } = require('../services/purchasesStore');

// ── Cada negocio es dueño de sus propias compras ──
async function resolvePurchaseBusiness(bizId) {
  return bizId;
}

// ── Credenciales siempre del principal ──
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

    // 1) Proveedores
    let suppliersCount = 0;
    try {
      const proveedores = await fetchMaxiSuppliers({ businessId: credsBizId, req });
      suppliersCount = await upsertSuppliers(businessId, proveedores);
    } catch (e) {
      console.warn('[purchases.sync] Proveedores falló (no crítico):', e.message);
    }

    // 2) Compras
    const facturas = await fetchMaxiPurchases({ businessId: credsBizId, req, from, to, provdr, num });
    if (!facturas.length) {
      return res.json({ ok: true, inserted: 0, updated: 0, items: 0, suppliers: suppliersCount, message: 'Sin compras en el rango' });
    }

    // 3) Cruzar con insumos
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
exports.syncSuppliers = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    const credsBizId = await resolveCredsBizId(rawBizId);
    const proveedores = await fetchMaxiSuppliers({ businessId: credsBizId, req });
    const count = await upsertSuppliers(rawBizId, proveedores);
    res.json({ ok: true, suppliers: count });
  } catch (e) { next(e); }
};

// GET /api/purchases/suppliers
exports.listSuppliers = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    const businessId = await resolvePurchaseBusiness(rawBizId);
    const { rows } = await pool.query(
      'SELECT id, nombre, razon_social, cuit FROM suppliers WHERE business_id = $1 ORDER BY nombre ASC',
      [businessId]
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
// ─────────────────────────────────────────────────────────────────────────────
exports.list = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    if (!rawBizId) return res.status(400).json({ ok: false, error: 'business_id requerido' });
    const businessId = await resolvePurchaseBusiness(rawBizId);

    const { page = 1, limit = 500 } = req.query;
    const hardLimit = Math.min(Math.max(Number(limit), 1), 10000);
    const offset = (Math.max(Number(page), 1) - 1) * hardLimit;

    const baseParams = [businessId];
    const baseWhere = ['pi.business_id = $1'];
    const { where: extraWhere, params: extraParams } = buildPurchaseFilters(req.query, 2);

    const allWhere = [...baseWhere, ...extraWhere];
    const allParams = [...baseParams, ...extraParams];
    const whereSql = 'WHERE ' + allWhere.join(' AND ');

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
         LEFT JOIN suppliers s   ON s.id = p.proveedor_id
         LEFT JOIN insumos   i   ON i.id = pi.insumo_id
         ${whereSql}
         ORDER BY pi.fecha DESC, p.factura_key, pi.id
         LIMIT $${allParams.length + 1}
         OFFSET $${allParams.length + 2}`,
        [...allParams, hardLimit, offset]
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
// GET /api/purchases/summary?from=&to=&branch_id=
// ─────────────────────────────────────────────────────────────────────────────
exports.summary = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    const businessId = await resolvePurchaseBusiness(rawBizId);

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
         LEFT JOIN suppliers s   ON s.id = p.proveedor_id
         WHERE pi.business_id = $1 ${extraFilterSql}
         GROUP BY s.id, s.nombre, s.cuit${branchGroup}
         ORDER BY total DESC NULLS LAST`,
      allParams
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
    const businessId = await resolvePurchaseBusiness(rawBizId);

    const baseParams = [businessId];
    const baseWhere = ['pi.business_id = $1'];
    const { where: extraWhere, params: extraParams } = buildPurchaseFilters(req.query, 2);

    const allWhere = [...baseWhere, ...extraWhere];
    const allParams = [...baseParams, ...extraParams];

    const { rows } = await pool.query(
      `SELECT
           pi.fecha,
           p.factura_key                           AS factura,
           COALESCE(ab.name, '—')                  AS sucursal,
           COALESCE(s.nombre, pi.referencia)       AS proveedor,
           i.codigo_maxi,
           COALESCE(i.nombre, pi.referencia)       AS insumo,
           COALESCE(i.unidad_med, '')              AS unidad,
           pi.cantidad,
           pi.precio                               AS precio_unit,
           pi.precio_total                         AS total_neto
         FROM purchase_items pi
         JOIN purchases p        ON p.id = pi.purchase_id
         LEFT JOIN app_branches ab ON ab.id = p.branch_id
         LEFT JOIN suppliers s   ON s.id = p.proveedor_id
         LEFT JOIN insumos   i   ON i.id = pi.insumo_id
         WHERE ${allWhere.join(' AND ')}
         ORDER BY pi.fecha ASC, p.factura_key, pi.id`,
      allParams
    );

    const headers = ['Fecha', 'Factura', 'Sucursal', 'Proveedor', 'Cod.Maxi', 'Insumo', 'Unidad', 'Cantidad', 'Precio unit.', 'Total neto'];
    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(';') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [
      headers.join(';'),
      ...rows.map((r) => [
        esc(r.fecha ? String(r.fecha).slice(0, 10) : ''),
        esc(r.factura),
        esc(r.sucursal),
        esc(r.proveedor),
        esc(r.codigo_maxi),
        esc(r.insumo),
        esc(r.unidad),
        Number(r.cantidad || 0).toFixed(2).replace('.', ','),
        Number(r.precio_unit || 0).toFixed(2).replace('.', ','),
        Number(r.total_neto || 0).toFixed(2).replace('.', ','),
      ].join(';')),
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
    const businessId = await resolvePurchaseBusiness(rawBizId);

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