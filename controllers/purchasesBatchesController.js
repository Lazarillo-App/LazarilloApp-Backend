// controllers/purchasesBatchesController.js
'use strict';

const pool = require('../config/db');
const getBusinessId = require('../utils/getBusinessId');

/* ─── helpers ─── */
function generateBatchId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 6);
  return `${date}-${time}-${rand}`;
}
exports.generateBatchId = generateBatchId;

/**
 * GET /api/purchases/batches
 */
exports.listBatches = async (req, res, next) => {
  try {
    const bizId = getBusinessId(req);
    if (!bizId) return res.status(400).json({ ok: false, error: 'business_id requerido' });

    const { rows } = await pool.query(
      `SELECT
         p.batch_id,
         MIN(p.synced_at)::timestamptz AS created_at,
         COUNT(pi.id)::int             AS total_items,
         p.business_id,
         b.name                        AS business_name
       FROM purchases p
       LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
       LEFT JOIN app_businesses b  ON b.id = p.business_id
       WHERE p.business_id = $1
         AND p.batch_id IS NOT NULL
       GROUP BY p.batch_id, p.business_id, b.name
       ORDER BY MIN(p.synced_at) DESC`,
      [bizId]
    );

    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[listBatches] error:', e);
    next(e);
  }
};

/**
 * GET /api/purchases/batches/:batchId/preview?limit=20
 *
 * Schema confirmado:
 *   purchases      → id, fecha(date), factura_key, proveedor_id, neto_total,
 *                    iva_total, imp_int_total, total, synced_at, batch_id
 *   purchase_items → id, purchase_id, insumo_id, fecha, branch_id, cantidad,
 *                    neto, precio, precio_total, iva_tasa, iva, referencia, source
 *   suppliers      → id, business_id, nombre, razon_social, cuit
 *
 *   JOIN: suppliers.id = purchases.proveedor_id
 *   Nombre del insumo: purchase_items.referencia
 */
exports.previewBatch = async (req, res, next) => {
  try {
    const bizId   = getBusinessId(req);
    const { batchId } = req.params;
    const limit   = Math.min(Number(req.query.limit) || 20, 100);

    if (!bizId)   return res.status(400).json({ ok: false, error: 'business_id requerido' });
    if (!batchId) return res.status(400).json({ ok: false, error: 'batchId requerido' });

    // Verificar pertenencia del lote al negocio
    const { rows: check } = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM purchases
       WHERE batch_id = $1 AND business_id = $2`,
      [batchId, bizId]
    );
    if (!check[0]?.cnt) {
      return res.status(404).json({ ok: false, error: 'Lote no encontrado para este negocio' });
    }

    // Total de ítems del lote
    const { rows: tRows } = await pool.query(
      `SELECT COUNT(pi.id)::int AS total
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
       WHERE p.batch_id = $1 AND p.business_id = $2`,
      [batchId, bizId]
    );
    const total = tRows[0]?.total ?? 0;

    // Vista previa desnormalizada con columnas exactas del esquema
    const { rows } = await pool.query(
      `SELECT
         TO_CHAR(p.fecha, 'DD/MM/YYYY')               AS "Fecha",
         COALESCE(s.nombre, s.razon_social, '—')      AS "Proveedor",
         COALESCE(p.factura_key, '—')                 AS "Factura",
         COALESCE(pi.referencia, '—')                 AS "Insumo",
         pi.cantidad                                   AS "Cantidad",
         pi.precio                                     AS "Precio Unit.",
         pi.precio_total                               AS "Total Ítem",
         p.neto_total                                  AS "Neto Compra",
         p.iva_total                                   AS "IVA Compra",
         p.total                                       AS "Total Compra"
       FROM purchases p
       LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
       LEFT JOIN suppliers s       ON s.id = p.proveedor_id
       WHERE p.batch_id = $1 AND p.business_id = $2
       ORDER BY p.fecha DESC, p.id, pi.id
       LIMIT $3`,
      [batchId, bizId, limit]
    );

    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    res.json({ ok: true, columns, rows, total, showing: rows.length });

  } catch (e) {
    console.error('[previewBatch] ERROR:', {
      message: e.message,
      code:    e.code,
      detail:  e.detail,
      hint:    e.hint,
    });
    next(e);
  }
};

/**
 * DELETE /api/purchases/batches/:batchId
 */
exports.deleteBatch = async (req, res, next) => {
  try {
    const bizId   = getBusinessId(req);
    const { batchId } = req.params;

    if (!bizId)   return res.status(400).json({ ok: false, error: 'business_id requerido' });
    if (!batchId) return res.status(400).json({ ok: false, error: 'batchId requerido' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: check } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM purchases WHERE batch_id = $1 AND business_id = $2`,
        [batchId, bizId]
      );
      if (!check[0]?.cnt) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'Lote no encontrado para este negocio' });
      }

      const { rowCount: itemsDeleted } = await client.query(
        `DELETE FROM purchase_items
         WHERE purchase_id IN (
           SELECT id FROM purchases WHERE batch_id = $1 AND business_id = $2
         )`,
        [batchId, bizId]
      );
      const { rowCount: purchasesDeleted } = await client.query(
        `DELETE FROM purchases WHERE batch_id = $1 AND business_id = $2`,
        [batchId, bizId]
      );

      await client.query('COMMIT');
      res.json({
        ok: true,
        batch_id: batchId,
        purchases_deleted: purchasesDeleted,
        items_deleted: itemsDeleted,
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[deleteBatch] error:', e);
    next(e);
  }
};

/**
 * POST /api/purchases/batches/:batchId/move
 */
exports.moveBatch = async (req, res, next) => {
  try {
    const bizId            = getBusinessId(req);
    const { batchId }      = req.params;
    const targetBusinessId = Number(req.body?.targetBusinessId);

    if (!bizId)   return res.status(400).json({ ok: false, error: 'business_id requerido' });
    if (!batchId) return res.status(400).json({ ok: false, error: 'batchId requerido' });
    if (!Number.isFinite(targetBusinessId) || targetBusinessId <= 0)
      return res.status(400).json({ ok: false, error: 'targetBusinessId inválido' });
    if (Number(bizId) === targetBusinessId)
      return res.status(400).json({ ok: false, error: 'El negocio destino es el mismo que el origen' });

    const { rows: bizCheck } = await pool.query(
      `SELECT id FROM app_businesses WHERE id = $1`, [targetBusinessId]
    );
    if (!bizCheck.length)
      return res.status(404).json({ ok: false, error: 'Negocio destino no encontrado' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: check } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM purchases WHERE batch_id = $1 AND business_id = $2`,
        [batchId, bizId]
      );
      if (!check[0]?.cnt) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'Lote no encontrado para este negocio' });
      }

      await client.query(
        `UPDATE purchase_items SET business_id = $1
         WHERE purchase_id IN (
           SELECT id FROM purchases WHERE batch_id = $2 AND business_id = $3
         )`,
        [targetBusinessId, batchId, bizId]
      );
      const { rowCount: moved } = await client.query(
        `UPDATE purchases SET business_id = $1 WHERE batch_id = $2 AND business_id = $3`,
        [targetBusinessId, batchId, bizId]
      );

      await client.query('COMMIT');
      res.json({
        ok: true,
        batch_id: batchId,
        from_business_id: bizId,
        to_business_id: targetBusinessId,
        purchases_moved: moved,
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[moveBatch] error:', e);
    next(e);
  }
};

/**
 * GET /api/businesses/:id/config
 */
exports.getConfig = async (req, res, next) => {
  try {
    const bizId = req.params.id || getBusinessId(req);
    const { rows } = await pool.query(
      `SELECT props FROM app_businesses WHERE id = $1`, [bizId]
    );
    const props = rows[0]?.props || {};
    res.json({
      ok: true,
      business_id: bizId,
      config: {
        articulos_costo_ideal:  props.articulos_costo_ideal  ?? null,
        insumos_costo_ideal:    props.insumos_costo_ideal    ?? null,
        compras_alerta_semanas: props.compras_alerta_semanas ?? null,
        ventas_alerta_dias:     props.ventas_alerta_dias     ?? null,
      },
    });
  } catch (e) { next(e); }
};

/**
 * PATCH /api/businesses/:id/config
 */
exports.saveConfig = async (req, res, next) => {
  try {
    const bizId   = req.params.id || getBusinessId(req);
    const allowed = [
      'articulos_costo_ideal',
      'insumos_costo_ideal',
      'compras_alerta_semanas',
      'ventas_alerta_dias',
    ];
    const update = {};
    for (const key of allowed) {
      if (req.body && key in req.body) {
        const v = req.body[key];
        update[key] = v === null || v === '' ? null : Number(v);
      }
    }
    if (!Object.keys(update).length)
      return res.status(400).json({ ok: false, error: 'No hay campos a actualizar' });

    const setters = Object.keys(update)
      .map((k, i) => `jsonb_build_object('${k}', $${i + 2}::numeric)`)
      .join(' || ');

    await pool.query(
      `UPDATE app_businesses
       SET props = COALESCE(props, '{}'::jsonb) || (${setters})
       WHERE id = $1`,
      [bizId, ...Object.values(update)]
    );

    res.json({ ok: true, business_id: bizId, updated: update });
  } catch (e) { next(e); }
};