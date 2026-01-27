// services/syncChangeSetApplyService.js
'use strict';

const pool = require('../config/db');

function getCodeFromEntityId(entityId) {
  // "codigo_maxi:123"
  const m = String(entityId || '').match(/codigo_maxi:(\d+)/);
  return m ? Number(m[1]) : null;
}

async function applyInsumosChangeSet({ businessId, changeSetId, userId }) {
  const bid = Number(businessId);
  const csid = Number(changeSetId);
  if (!Number.isFinite(bid) || bid <= 0) throw new Error('businessId inválido');
  if (!Number.isFinite(csid) || csid <= 0) throw new Error('changeSetId inválido');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const csRes = await client.query(
      `SELECT id, status, summary, changes
       FROM sync_change_sets
       WHERE id=$1 AND business_id=$2
       FOR UPDATE`,
      [csid, bid]
    );
    const cs = csRes.rows[0];
    if (!cs) throw new Error('change_set no encontrado');
    if (cs.status !== 'approved') {
      throw new Error(`No se puede aplicar: status=${cs.status}. Debe estar en approved.`);
    }

    const changes = Array.isArray(cs.changes) ? cs.changes : [];

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const ch of changes) {
      if (ch?.entity !== 'insumo') { skipped++; continue; }

      const code = getCodeFromEntityId(ch.entity_id);
      if (!Number.isFinite(code)) { skipped++; continue; }

      if (ch.action === 'create') {
        // Usamos valores "to" desde fields
        const f = ch.fields || {};
        const nombre = f?.nombre?.to ?? '';
        const rubro = f?.rubro?.to ?? null;
        const unidad_med = f?.unidad_med?.to ?? null;
        const precio_ref = f?.precio_ref?.to ?? null;

        await client.query(`
          INSERT INTO insumos
            (business_id, codigo_maxi, nombre, rubro, unidad_med, precio_ref, origen, activo, created_at, updated_at)
          VALUES ($1, $2::text, $3, $4, $5, $6, 'maxi', true, now(), now())
          ON CONFLICT (business_id, codigo_maxi)
          DO UPDATE SET
            nombre = EXCLUDED.nombre,
            rubro = EXCLUDED.rubro,
            unidad_med = EXCLUDED.unidad_med,
            precio_ref = EXCLUDED.precio_ref,
            updated_at = now()
        `, [bid, String(code), String(nombre), rubro, unidad_med, precio_ref]);

        inserted++;
        continue;
      }

      if (ch.action === 'update') {
        // Solo actualizamos campos que estén en fields
        const f = ch.fields || {};
        const sets = [];
        const vals = [bid, String(code)];
        let idx = 3;

        const map = {
          nombre: 'nombre',
          rubro: 'rubro',
          unidad_med: 'unidad_med',
          precio_ref: 'precio_ref',
          costo_ref: 'costo_ref',
          iva: 'iva',
        };

        for (const [k, col] of Object.entries(map)) {
          if (Object.prototype.hasOwnProperty.call(f, k)) {
            sets.push(`${col} = $${idx}`);
            vals.push(f[k]?.to ?? null);
            idx++;
          }
        }

        if (!sets.length) { skipped++; continue; }

        await client.query(`
          UPDATE insumos
          SET ${sets.join(', ')}, updated_at = now()
          WHERE business_id = $1 AND codigo_maxi = $2
        `, vals);

        updated++;
        continue;
      }

      // missing: no se aplica
      skipped++;
    }

    await client.query(`
      UPDATE sync_change_sets
      SET status='applied', applied_by=$2, applied_at=now()
      WHERE id=$1
    `, [csid, userId || null]);

    await client.query('COMMIT');

    return { ok: true, inserted, updated, skipped };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { applyInsumosChangeSet };
