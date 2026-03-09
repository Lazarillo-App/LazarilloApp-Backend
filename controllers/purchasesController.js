// controllers/purchasesController.js
'use strict';

const pool = require('../config/db');
const getBusinessId = require('../utils/getBusinessId');
const { fetchMaxiSuppliers, fetchMaxiPurchases } = require('../services/maxiPurchasesService');
const { upsertPurchasesBatch, upsertSuppliers } = require('../services/purchasesStore');

// Resuelve siempre al negocio principal de la org (igual que insumos)
async function resolvePurchaseBusiness(bizId) {
  const { rows } = await pool.query(
    'SELECT id, created_from, organization_id FROM app_businesses WHERE id = $1',
    [bizId]
  );
  const biz = rows[0];
  if (!biz) return bizId;
  // Si no es subnegocio, es el principal directamente
  if (biz.created_from !== 'from_group' || !biz.organization_id) return bizId;
  // Igual que resolveInsumoBusiness: principal = más antiguo con created_from != 'from_group'
  const { rows: rootRows } = await pool.query(
    `SELECT id FROM app_businesses
       WHERE organization_id = (
         SELECT organization_id FROM app_businesses WHERE id = $1
       )
       AND created_from != 'from_group'
       ORDER BY created_at ASC
       LIMIT 1`,
    [bizId]
  );
  return rootRows[0]?.id ?? bizId;
}

// Map<codigoMaxi:number, insumoId:number> para cruzar items con insumos
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

// POST /api/purchases/sync  { from, to, provdr?, num? }
exports.sync = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    if (!rawBizId) return res.status(400).json({ ok: false, error: 'business_id requerido' });
    const businessId = await resolvePurchaseBusiness(rawBizId);

    const { from, to, provdr, num } = req.body;
    if (!from || !to) return res.status(400).json({ ok: false, error: 'from y to son requeridos' });

    // 1) Proveedores (no critico)
    let suppliersCount = 0;
    try {
      const proveedores = await fetchMaxiSuppliers({ businessId, req });
      suppliersCount = await upsertSuppliers(businessId, proveedores);
      console.log('[purchases.sync] Proveedores:', suppliersCount);
    } catch (e) {
      console.warn('[purchases.sync] Proveedores fallo (no critico):', e.message);
    }

    // 2) Compras del rango
    const facturas = await fetchMaxiPurchases({ businessId, req, from, to, provdr, num });
    console.log('[purchases.sync] Facturas recibidas:', facturas.length);
    // 🔍 TEMPORAL - ver estructura de MaxiRest
    if (facturas.length > 0) {
      console.log('[purchases.sync] primera factura:', JSON.stringify(facturas[0], null, 2).slice(0, 800));
    }
    if (!facturas.length) {
      return res.json({ ok: true, inserted: 0, updated: 0, items: 0, suppliers: suppliersCount, message: 'Sin compras en el rango' });
    }

    // 3) Cruzar con insumos
    const insumoMap = await buildInsumoMap(businessId);
    console.log(`[purchases.sync] insumoMap: ${insumoMap.size} insumos con codigo_maxi. Primeras 5 claves:`, [...insumoMap.keys()].slice(0, 5));

    // 4) Upsert
    const result = await upsertPurchasesBatch(businessId, facturas, insumoMap);
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
    const businessId = await resolvePurchaseBusiness(rawBizId);
    const proveedores = await fetchMaxiSuppliers({ businessId, req });
    const count = await upsertSuppliers(businessId, proveedores);
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

// GET /api/purchases?from=&to=&proveedor_id=&insumo_id=&page=&limit=
exports.list = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    if (!rawBizId) return res.status(400).json({ ok: false, error: 'business_id requerido' });
    const businessId = await resolvePurchaseBusiness(rawBizId);

    const { from, to, proveedor_id, insumo_id, page = 1, limit = 500 } = req.query;
    const params = [businessId];
    const where  = ['pi.business_id = $1'];

    if (from)        { params.push(from);                where.push(`pi.fecha >= $${params.length}`); }
    if (to)          { params.push(to);                  where.push(`pi.fecha <= $${params.length}`); }
    if (proveedor_id){ params.push(Number(proveedor_id)); where.push(`p.proveedor_id = $${params.length}`); }
    if (insumo_id)   { params.push(Number(insumo_id));    where.push(`pi.insumo_id = $${params.length}`); }

    const whereSql  = 'WHERE ' + where.join(' AND ');
    const hardLimit = Math.min(Math.max(Number(limit), 1), 10000);
    const offset    = (Math.max(Number(page), 1) - 1) * hardLimit;

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT
           pi.id, pi.fecha,
           pi.insumo_id,
           p.factura_key         AS factura,
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
         JOIN purchases p  ON p.id = pi.purchase_id
         LEFT JOIN suppliers s ON s.id = p.proveedor_id
         LEFT JOIN insumos   i ON i.id = pi.insumo_id
         ${whereSql}
         ORDER BY pi.fecha DESC, p.factura_key, pi.id
         LIMIT $${params.length + 1}
         OFFSET $${params.length + 2}`,
        [...params, hardLimit, offset]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT pi.id)::int AS total
           FROM purchase_items pi
           JOIN purchases p ON p.id = pi.purchase_id
           ${whereSql}`,
        params
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

// GET /api/purchases/summary?from=&to=
exports.summary = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    const businessId = await resolvePurchaseBusiness(rawBizId);
    const { from, to } = req.query;

    const params = [businessId];
    const dateWhere = [];
    if (from) { params.push(from); dateWhere.push(`pi.fecha >= $${params.length}`); }
    if (to)   { params.push(to);   dateWhere.push(`pi.fecha <= $${params.length}`); }
    const dateFilter = dateWhere.length ? 'AND ' + dateWhere.join(' AND ') : '';

    const { rows } = await pool.query(
      `SELECT
           s.id             AS proveedor_id,
           s.nombre         AS proveedor_nombre,
           s.cuit,
           COUNT(DISTINCT p.id)::int       AS facturas,
           SUM(pi.cantidad)::numeric       AS cantidad_total,
           SUM(pi.precio_total)::numeric   AS neto_total,
           SUM(pi.iva_total_item)::numeric AS iva_total,
           SUM(pi.precio_total + COALESCE(pi.iva_total_item,0))::numeric AS total
         FROM purchase_items pi
         JOIN purchases p  ON p.id = pi.purchase_id
         LEFT JOIN suppliers s ON s.id = p.proveedor_id
         WHERE pi.business_id = $1 ${dateFilter}
         GROUP BY s.id, s.nombre, s.cuit
         ORDER BY total DESC NULLS LAST`,
      params
    );
    res.json({ ok: true, data: rows });
  } catch (e) { next(e); }
};

// GET /api/purchases/export/csv?from=&to=&proveedor_id=&insumo_id=
exports.exportCsv = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    const businessId = await resolvePurchaseBusiness(rawBizId);
    const { from, to, proveedor_id, insumo_id } = req.query;

    const params = [businessId];
    const where  = ['pi.business_id = $1'];
    if (from)        { params.push(from);                where.push(`pi.fecha >= $${params.length}`); }
    if (to)          { params.push(to);                  where.push(`pi.fecha <= $${params.length}`); }
    if (proveedor_id){ params.push(Number(proveedor_id)); where.push(`p.proveedor_id = $${params.length}`); }
    if (insumo_id)   { params.push(Number(insumo_id));    where.push(`pi.insumo_id = $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT
           pi.fecha,
           p.factura_key                           AS factura,
           COALESCE(s.nombre, pi.referencia)       AS proveedor,
           i.codigo_maxi,
           COALESCE(i.nombre, pi.referencia)       AS insumo,
           COALESCE(i.unidad_med, '')              AS unidad,
           pi.cantidad,
           pi.precio                               AS precio_unit,
           pi.precio_total                         AS total_neto
         FROM purchase_items pi
         JOIN purchases p  ON p.id = pi.purchase_id
         LEFT JOIN suppliers s ON s.id = p.proveedor_id
         LEFT JOIN insumos   i ON i.id = pi.insumo_id
         WHERE ${where.join(' AND ')}
         ORDER BY pi.fecha ASC, p.factura_key, pi.id`,
      params
    );

    const headers = [
      'Fecha', 'Factura', 'Proveedor',
      'Cod.Maxi', 'Insumo', 'Unidad',
      'Cantidad', 'Precio unit.', 'Total neto',
    ];

    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const lines = [
      headers.join(','),
      ...rows.map((r) => [
        r.fecha ? String(r.fecha).slice(0, 10) : '',
        r.factura,
        r.proveedor,
        r.codigo_maxi,
        r.insumo,
        r.unidad,
        r.cantidad,
        r.precio_unit != null ? Number(r.precio_unit).toFixed(4) : '',
        r.total_neto,
      ].map(esc).join(',')),
    ];

    const filename = `compras_${from ?? 'all'}_${to ?? 'all'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + lines.join('\r\n'));
  } catch (e) {
    console.error('[purchases.exportCsv] error:', e);
    next(e);
  }
};

// GET /api/purchases/first-date
// Devuelve la fecha más antigua con compras sincronizadas en la DB
exports.firstDate = async (req, res, next) => {
  try {
    const rawBizId = getBusinessId(req);
    if (!rawBizId) return res.status(400).json({ ok: false, error: 'business_id requerido' });
    const businessId = await resolvePurchaseBusiness(rawBizId);

    const { rows } = await pool.query(
      `SELECT MIN(fecha)::date AS first_date
         FROM purchase_items
        WHERE business_id = $1`,
      [businessId]
    );

    const firstDate = rows[0]?.first_date
      ? String(rows[0].first_date).slice(0, 10)   // "2024-08-15"
      : null;

    res.json({ ok: true, firstDate });
  } catch (e) {
    console.error('[purchases.firstDate] error:', e);
    next(e);
  }
};