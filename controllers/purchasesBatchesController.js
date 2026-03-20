// controllers/purchasesBatchesController.js
// Endpoints para gestión de lotes de importación de compras
// y configuración del negocio (% costo ideal, alertas de compras)
'use strict';

const pool = require('../config/db');
const getBusinessId = require('../utils/getBusinessId');

/* ─── helpers ─── */
/**
 * Genera un batch_id único con formato: YYYYMMDD-HHMMSS-<random4>
 * Ejemplo: 20260317-143022-a3f1
 */
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
 * Lista todos los lotes de importación del negocio activo.
 * Devuelve: [{ batch_id, created_at, total_items, business_id, business_name }]
 */
exports.listBatches = async (req, res, next) => {
  try {
    const bizId = getBusinessId(req);
    if (!bizId) return res.status(400).json({ ok: false, error: 'business_id requerido' });

    const { rows } = await pool.query(
      `SELECT
         p.batch_id,
         MIN(p.synced_at)::timestamptz AS created_at,
         COUNT(pi.id)::int AS total_items,
         p.business_id,
         b.name AS business_name
       FROM purchases p
       LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
       LEFT JOIN app_businesses b ON b.id = p.business_id
       WHERE p.business_id = $1
         AND p.batch_id IS NOT NULL
       GROUP BY p.batch_id, p.business_id, b.name
       ORDER BY MIN(p.created_at) DESC`,
      [bizId]
    );

    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[listBatches] error:', e);
    next(e);
  }
};

/**
 * DELETE /api/purchases/batches/:batchId
 * Elimina todos los registros de un lote de importación.
 */
exports.deleteBatch = async (req, res, next) => {
  try {
    const bizId = getBusinessId(req);
    const { batchId } = req.params;

    if (!bizId) return res.status(400).json({ ok: false, error: 'business_id requerido' });
    if (!batchId) return res.status(400).json({ ok: false, error: 'batchId requerido' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que el lote pertenece al negocio
      const { rows: check } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM purchases WHERE batch_id = $1 AND business_id = $2`,
        [batchId, bizId]
      );
      if (!check[0]?.cnt) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'Lote no encontrado para este negocio' });
      }

      // Eliminar items primero (FK)
      const { rowCount: itemsDeleted } = await client.query(
        `DELETE FROM purchase_items
         WHERE purchase_id IN (
           SELECT id FROM purchases WHERE batch_id = $1 AND business_id = $2
         )`,
        [batchId, bizId]
      );

      // Eliminar compras
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
 * body: { targetBusinessId: number }
 * Mueve todos los registros de un lote a otro negocio.
 */
exports.moveBatch = async (req, res, next) => {
  try {
    const bizId = getBusinessId(req);
    const { batchId } = req.params;
    const targetBusinessId = Number(req.body?.targetBusinessId);

    if (!bizId) return res.status(400).json({ ok: false, error: 'business_id requerido' });
    if (!batchId) return res.status(400).json({ ok: false, error: 'batchId requerido' });
    if (!Number.isFinite(targetBusinessId) || targetBusinessId <= 0) {
      return res.status(400).json({ ok: false, error: 'targetBusinessId inválido' });
    }
    if (Number(bizId) === targetBusinessId) {
      return res.status(400).json({ ok: false, error: 'El negocio destino es el mismo que el origen' });
    }

    // Verificar que el negocio destino existe
    const { rows: bizCheck } = await pool.query(
      `SELECT id FROM app_businesses WHERE id = $1`, [targetBusinessId]
    );
    if (!bizCheck.length) {
      return res.status(404).json({ ok: false, error: 'Negocio destino no encontrado' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar que el lote pertenece al negocio origen
      const { rows: check } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM purchases WHERE batch_id = $1 AND business_id = $2`,
        [batchId, bizId]
      );
      if (!check[0]?.cnt) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'Lote no encontrado para este negocio' });
      }

      // Mover purchase_items
      await client.query(
        `UPDATE purchase_items
         SET business_id = $1
         WHERE purchase_id IN (
           SELECT id FROM purchases WHERE batch_id = $2 AND business_id = $3
         )`,
        [targetBusinessId, batchId, bizId]
      );

      // Mover purchases
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
 * Devuelve la configuración del negocio (desde props).
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
        articulos_costo_ideal: props.articulos_costo_ideal ?? null,
        insumos_costo_ideal: props.insumos_costo_ideal ?? null,
        compras_alerta_semanas: props.compras_alerta_semanas ?? null,
      },
    });
  } catch (e) {
    next(e);
  }
};

/**
 * PATCH /api/businesses/:id/config
 * body: { articulos_costo_ideal?, insumos_costo_ideal?, compras_alerta_semanas? }
 * Guarda configuración en props del negocio.
 */
exports.saveConfig = async (req, res, next) => {
  try {
    const bizId = req.params.id || getBusinessId(req);
    const allowed = ['articulos_costo_ideal', 'insumos_costo_ideal', 'compras_alerta_semanas'];
    const update = {};
    for (const key of allowed) {
      if (req.body && key in req.body) {
        const v = req.body[key];
        update[key] = v === null || v === '' ? null : Number(v);
      }
    }
    if (!Object.keys(update).length) {
      return res.status(400).json({ ok: false, error: 'No hay campos a actualizar' });
    }

    // Merge con props existentes
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
  } catch (e) {
    next(e);
  }
};