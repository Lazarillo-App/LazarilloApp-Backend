// services/syncChangeSetApplyService.js
'use strict';

const pool = require('../config/db');

function getCodeFromEntityId(entityId) {
  const m = String(entityId || '').match(/codigo_maxi:(\d+)/);
  return m ? Number(m[1]) : null;
}

const normStr = (v) => (v == null ? null : String(v).trim());
const toIntOrNull = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const toNumOrNull = (v) => {
  if (v == null) return null;
  const s = String(v).trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function parseChanges(raw) {
  if (Array.isArray(raw)) return raw;
  // por si quedó guardado como string JSON
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }
  return [];
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
      `
      SELECT id, status, summary, changes
      FROM sync_change_sets
      WHERE id=$1 AND business_id=$2
      FOR UPDATE
      `,
      [csid, bid]
    );

    const cs = csRes.rows[0];
    if (!cs) throw new Error('change_set no encontrado');
    if (cs.status !== 'approved') {
      throw new Error(`No se puede aplicar: status=${cs.status}. Debe estar en approved.`);
    }

    const changes = parseChanges(cs.changes);

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const ch of changes) {
      if (ch?.entity !== 'insumo') { skipped++; continue; }

      const code = getCodeFromEntityId(ch.entity_id);
      if (!Number.isFinite(code) || code <= 0) { skipped++; continue; }

      const f = ch.fields || {};

      if (ch.action === 'create') {
        const nombre = normStr(f?.nombre?.to) || '';
        const rubro = toIntOrNull(f?.rubro?.to);
        const unidad_med = normStr(f?.unidad_med?.to);
        const precio_ref = toNumOrNull(f?.precio_ref?.to);

        const r = await client.query(
          `
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
          `,
          [bid, String(code), String(nombre), rubro, unidad_med, precio_ref]
        );

        // INSERT/UPSERT en PG suele dar rowCount 1
        inserted += (r.rowCount || 0);
        continue;
      }

      if (ch.action === 'update') {
        const sets = [];
        const vals = [bid, String(code)];
        let idx = 3;

        // Mapeo field -> columna
        const map = {
          nombre:   { col: 'nombre',     cast: (x) => normStr(x) },
          rubro:    { col: 'rubro',      cast: (x) => toIntOrNull(x) },
          unidad_med:{ col:'unidad_med', cast: (x) => normStr(x) },
          precio_ref:{ col:'precio_ref', cast: (x) => toNumOrNull(x) },
          costo_ref:{ col:'costo_ref',   cast: (x) => toNumOrNull(x) },
          iva:      { col: 'iva',        cast: (x) => normStr(x) },
        };

        for (const [k, spec] of Object.entries(map)) {
          if (Object.prototype.hasOwnProperty.call(f, k)) {
            sets.push(`${spec.col} = $${idx}`);
            vals.push(spec.cast(f[k]?.to));
            idx++;
          }
        }

        if (!sets.length) { skipped++; continue; }

        const r = await client.query(
          `
          UPDATE insumos
          SET ${sets.join(', ')}, updated_at = now()
          WHERE business_id = $1 AND codigo_maxi = $2
          `,
          vals
        );

        updated += (r.rowCount || 0);
        continue;
      }

      // missing u otras acciones: no se aplica por ahora
      skipped++;
    }

    // ✅ marcar como aplicado SOLO para ese business
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

    return { ok: true, inserted, updated, skipped };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { applyInsumosChangeSet };
