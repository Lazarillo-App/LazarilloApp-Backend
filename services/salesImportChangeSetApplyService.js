// services/salesImportChangeSetApplyService.js
'use strict';

const pool = require('../config/db');
const { rebuildSalesDailyRange } = require('./salesDailyRebuildService');

function pickRange(summary) {
  const r = summary?.range || summary?.date_range || null;
  const from = r?.from ? String(r.from).slice(0, 10) : null;
  const to = r?.to ? String(r.to).slice(0, 10) : null;
  if (!from || !to) return null;
  return { from, to };
}

async function applySalesImportChangeSet({ businessId, changeSetId, userId }) {
  const bid = Number(businessId);
  const csid = Number(changeSetId);
  if (!Number.isFinite(bid) || bid <= 0) throw new Error('businessId inválido');
  if (!Number.isFinite(csid) || csid <= 0) throw new Error('changeSetId inválido');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Lock change set
    const csRes = await client.query(
      `
      SELECT id, status, scope, summary
      FROM sync_change_sets
      WHERE id=$1 AND business_id=$2
      FOR UPDATE
      `,
      [csid, bid]
    );

    const cs = csRes.rows[0];
    if (!cs) throw new Error('change_set no encontrado');
    if (cs.scope !== 'sales_import') throw new Error(`scope inválido: ${cs.scope}`);
    if (cs.status !== 'approved') {
      throw new Error(`No se puede aplicar: status=${cs.status}. Debe estar en approved.`);
    }

    const summary = cs.summary || {};
    const importId = Number(summary.import_id);
    if (!Number.isFinite(importId) || importId <= 0) {
      throw new Error('summary.import_id faltante o inválido');
    }

    const rangeFromSummary = pickRange(summary);
    if (!rangeFromSummary) throw new Error('summary.range {from,to} faltante o inválido');

    // 2) Lock import y validar estado
    const impRes = await client.query(
      `
      SELECT id, business_id, status, date_from, date_to
      FROM sales_csv_imports
      WHERE id=$1 AND business_id=$2
      FOR UPDATE
      `,
      [importId, bid]
    );

    const imp = impRes.rows[0];
    if (!imp) throw new Error(`import_id=${importId} no existe para business=${bid}`);

    // ✅ Más seguro: solo estos estados
    if (!['awaiting_approval', 'completed'].includes(imp.status)) {
      throw new Error(`Import no aplicable: status=${imp.status}`);
    }

    // ✅ Rango final: preferimos lo que quedó guardado en el import
    const range = {
      from: String(imp.date_from || rangeFromSummary.from).slice(0, 10),
      to: String(imp.date_to || rangeFromSummary.to).slice(0, 10),
    };

    // 3) Validar staging (y que tenga algo en el rango)
    const staged = await client.query(
      `
      SELECT COUNT(*)::int AS count
      FROM sales_csv_import_items
      WHERE import_id = $1
        AND business_id = $2
        AND day BETWEEN $3::date AND $4::date
      `,
      [importId, bid, range.from, range.to]
    );

    const stagedCount = Number(staged.rows?.[0]?.count || 0);
    if (stagedCount <= 0) {
      throw new Error(`No hay filas en staging en rango para import_id=${importId} (business=${bid})`);
    }

    // 4) Borrar rango existente (solo csv)
    const del = await client.query(
      `
      DELETE FROM sales_daily_items
      WHERE business_id = $1
        AND source = 'csv'
        AND day BETWEEN $2::date AND $3::date
      `,
      [bid, range.from, range.to]
    );

    // 5) Insertar staging (SOLO rango) con upsert
    const ins = await client.query(
      `
      INSERT INTO sales_daily_items
        (business_id, day, article_id, qty, amount, article_name, source, created_at, updated_at)
      SELECT
        business_id, day, article_id, qty, amount, article_name,
        'csv', now(), now()
      FROM sales_csv_import_items
      WHERE import_id = $1
        AND business_id = $2
        AND day BETWEEN $3::date AND $4::date
      ON CONFLICT (business_id, day, article_id, source)
      DO UPDATE SET
        qty = EXCLUDED.qty,
        amount = EXCLUDED.amount,
        article_name = COALESCE(EXCLUDED.article_name, sales_daily_items.article_name),
        updated_at = now()
      `,
      [importId, bid, range.from, range.to]
    );

    // ✅ Rebuild sales_daily dentro de la misma TX
    await rebuildSalesDailyRange({
      businessId: bid,
      from: range.from,
      to: range.to,
      client,
    });

    // 6) Marcar import como completed (clave para UI)
    await client.query(
      `
      UPDATE sales_csv_imports
      SET status='completed',
          processed_at=now(),
          rows_inserted = $3
      WHERE id=$1 AND business_id=$2
      `,
      [importId, bid, ins.rowCount || 0]
    );

    // 7) Marcar change set como aplicado
    const mark = await client.query(
      `
      UPDATE sync_change_sets
      SET status='applied', applied_by=$3, applied_at=now()
      WHERE id=$1 AND business_id=$2
      `,
      [csid, bid, userId || null]
    );

    if ((mark.rowCount || 0) === 0) {
      throw new Error('no se pudo marcar aplicado (change_set no pertenece al negocio)');
    }

    await client.query('COMMIT');

    return {
      ok: true,
      scope: 'sales_import',
      import_id: importId,
      range,
      deleted: del.rowCount || 0,
      upserted: ins.rowCount || 0,
      staged_rows_in_range: stagedCount,
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { applySalesImportChangeSet };
