// controllers/salesBatchesController.js
// Gestión de lotes de importación de ventas (sales_csv_imports / sales_csv_import_items)
'use strict';

const pool = require('../config/db');
const getBusinessId = require('../utils/getBusinessId');

/**
 * GET /api/sales/batches
 * Lista todos los lotes de importación de ventas del negocio activo.
 * Respuesta: [{ batch_id, created_at, total_items, business_id, business_name,
 *               original_name, date_from, date_to, status }]
 */
exports.listBatches = async (req, res, next) => {
  try {
    const bizId = getBusinessId(req);
    if (!bizId) return res.status(400).json({ ok: false, error: 'business_id requerido' });

    const { rows } = await pool.query(
      `SELECT
         sci.id::text                  AS batch_id,
         sci.created_at,
         sci.row_count                 AS total_items,
         sci.business_id,
         b.name                        AS business_name,
         sci.original_name,
         sci.date_from,
         sci.date_to,
         sci.status,
         sci.rows_inserted,
         sci.rows_failed,
         sci.branch_id,
         ab.name                       AS branch_name
       FROM sales_csv_imports sci
       LEFT JOIN app_businesses b  ON b.id  = sci.business_id
       LEFT JOIN app_branches   ab ON ab.id = sci.branch_id
       WHERE sci.business_id = $1
       ORDER BY sci.created_at DESC`,
      [bizId]
    );
    
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[sales.listBatches] error:', e);
    next(e);
  }
};

/**
 * GET /api/sales/batches/:batchId/preview?limit=20
 *
 * Schema confirmado:
 *   sales_csv_imports      → id, business_id, original_name, date_from, date_to,
 *                            row_count, status, rows_inserted, created_at
 *   sales_csv_import_items → import_id, business_id, day, article_id, qty,
 *                            amount, article_name, created_at
 */
exports.previewBatch = async (req, res, next) => {
  try {
    const bizId   = getBusinessId(req);
    const { batchId } = req.params;
    const limit   = Math.min(Number(req.query.limit) || 20, 100);

    if (!bizId)   return res.status(400).json({ ok: false, error: 'business_id requerido' });
    if (!batchId) return res.status(400).json({ ok: false, error: 'batchId requerido' });

    // Verificar que el lote pertenece al negocio
    const { rows: check } = await pool.query(
      `SELECT id, original_name, date_from, date_to, row_count, status
       FROM sales_csv_imports
       WHERE id = $1 AND business_id = $2`,
      [batchId, bizId]
    );
    if (!check.length) {
      return res.status(404).json({ ok: false, error: 'Lote no encontrado para este negocio' });
    }
    const importMeta = check[0];

    // Total de ítems
    const { rows: tRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM sales_csv_import_items
       WHERE import_id = $1 AND business_id = $2`,
      [batchId, bizId]
    );
    const total = tRows[0]?.total ?? 0;

    // Vista previa — columnas exactas del esquema confirmado
    const { rows } = await pool.query(
      `SELECT
         TO_CHAR(sci.day, 'DD/MM/YYYY')      AS "Fecha",
         COALESCE(sci.article_name, '—')     AS "Artículo",
         sci.qty                              AS "Cantidad",
         sci.amount                           AS "Importe",
         sci.article_id                       AS "ID Artículo"
       FROM sales_csv_import_items sci
       WHERE sci.import_id = $1 AND sci.business_id = $2
       ORDER BY sci.day ASC, sci.article_name ASC
       LIMIT $3`,
      [batchId, bizId, limit]
    );

    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    res.json({
      ok: true,
      columns,
      rows,
      total,
      showing: rows.length,
      meta: {
        original_name: importMeta.original_name,
        date_from:     importMeta.date_from,
        date_to:       importMeta.date_to,
        status:        importMeta.status,
      },
    });
  } catch (e) {
    console.error('[sales.previewBatch] ERROR:', {
      message: e.message,
      code:    e.code,
      detail:  e.detail,
    });
    next(e);
  }
};

/**
 * DELETE /api/sales/batches/:batchId
 * Elimina un lote completo (import + items).
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

      // Verificar pertenencia
      const { rows: check } = await client.query(
        `SELECT id FROM sales_csv_imports WHERE id = $1 AND business_id = $2`,
        [batchId, bizId]
      );
      if (!check.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'Lote no encontrado para este negocio' });
      }

      // Eliminar ítems primero (FK)
      const { rowCount: itemsDeleted } = await client.query(
        `DELETE FROM sales_csv_import_items WHERE import_id = $1 AND business_id = $2`,
        [batchId, bizId]
      );

      // Eliminar también de sales_daily_items los registros de esta importación
      // (si tienen source = 'csv' y coinciden por business_id + rango de fechas)
      // Nota: no hay FK directa, así que es best-effort por import_id si existe la columna,
      // o lo dejamos para una limpieza manual si no hay trazabilidad directa.
      // Por ahora solo borramos el import header.
      const { rowCount: importDeleted } = await client.query(
        `DELETE FROM sales_csv_imports WHERE id = $1 AND business_id = $2`,
        [batchId, bizId]
      );

      await client.query('COMMIT');

      res.json({
        ok: true,
        batch_id: batchId,
        import_deleted: importDeleted,
        items_deleted:  itemsDeleted,
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[sales.deleteBatch] error:', e);
    next(e);
  }
};

/**
 * POST /api/sales/batches/:batchId/move
 * body: { targetBusinessId: number }
 * Mueve un lote de ventas a otro negocio.
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

    // Verificar que el negocio destino existe
    const { rows: bizCheck } = await pool.query(
      `SELECT id FROM app_businesses WHERE id = $1`, [targetBusinessId]
    );
    if (!bizCheck.length)
      return res.status(404).json({ ok: false, error: 'Negocio destino no encontrado' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verificar pertenencia
      const { rows: check } = await client.query(
        `SELECT id FROM sales_csv_imports WHERE id = $1 AND business_id = $2`,
        [batchId, bizId]
      );
      if (!check.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'Lote no encontrado para este negocio' });
      }

      // Mover ítems
      await client.query(
        `UPDATE sales_csv_import_items SET business_id = $1 WHERE import_id = $2 AND business_id = $3`,
        [targetBusinessId, batchId, bizId]
      );

      // Mover header
      const { rowCount: moved } = await client.query(
        `UPDATE sales_csv_imports SET business_id = $1 WHERE id = $2 AND business_id = $3`,
        [targetBusinessId, batchId, bizId]
      );

      await client.query('COMMIT');

      res.json({
        ok: true,
        batch_id:        batchId,
        from_business_id: bizId,
        to_business_id:  targetBusinessId,
        imports_moved:   moved,
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[sales.moveBatch] error:', e);
    next(e);
  }
};