// services/sync/insumosSyncPolicy.js
'use strict';

const pool = require('../../config/db');
const { fetchMaxiInsumos, normalizarInsumosMaxi } = require('../maxiSuppliesService');
const { upsertFromMaxi } = require('../../repos/insumosRepo');
const { autoAssignNewInsumos } = require('../autoAssignNewInsumos');
const { createSyncNotificationForBusinessUsers } = require('../notificationService');

/* =========================================================
   Locks: deben ser por CONEXIÓN (client), no pool.query suelto
   ========================================================= */

function lockKeyForInsumos(businessId) {
  return (0x1A5A0 ^ Number(businessId)) | 0;
}

async function tryLock(client, key) {
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
  return !!rows?.[0]?.locked;
}

async function unlock(client, key) {
  await client.query('SELECT pg_advisory_unlock($1)', [key]);
}

/* ========================================================= */

async function listBusinessesWithMaxi() {
  const { rows } = await pool.query(`
    SELECT id, name
    FROM app_businesses
    WHERE (props->'maxi'->>'email') IS NOT NULL
      AND (
        (props->'maxi'->>'codcli') IS NOT NULL
        OR (props->'maxi'->>'cod_cli') IS NOT NULL
      )
      AND (
        props->'maxi' ? 'pass_enc'
        OR props->'maxi' ? 'pass'
        OR props->'maxi' ? 'password'
      )
    ORDER BY id
  `);

  return rows
    .map(r => ({ id: Number(r.id), name: r.name || null }))
    .filter(x => Number.isFinite(x.id) && x.id > 0);
}

async function syncOneBusinessInsumos({ businessId, businessName, req }) {
  const client = await pool.connect();
  const lockKey = lockKeyForInsumos(businessId);
  let locked = false;

  try {
    locked = await tryLock(client, lockKey);
    if (!locked) {
      return { ok: false, skipped: true, reason: 'locked' };
    }

    // 1) fetch + normalizar (pasamos req para que respete X-Maxi-Token si lo usás en debug)
    const raw = await fetchMaxiInsumos({ businessId, req });
    const normalized = normalizarInsumosMaxi(raw);

    // 2) upsert (mantener estados locales: useIncomingEstado false)
    const summary = await upsertFromMaxi(businessId, normalized, {
      useIncomingEstado: false,
      collectChanges: false,
    });

    const inserted = Number(summary?.inserted || 0);
    const updated = Number(summary?.updated || 0);
    const unchanged = Number(summary?.unchanged || 0);

    // 3) auto-assign sólo si hay nuevos
    let autoAssigned = 0;
    if (inserted > 0) {
      try {
        const auto = await autoAssignNewInsumos(businessId);
        autoAssigned = Number(auto?.assigned || 0);
      } catch {
        // silencioso: no rompemos el sync por auto-assign
      }
    }

    // 4) notificar si hubo cambios
    if ((inserted + updated) > 0) {
      let msg = `Insertados: ${inserted}, Actualizados: ${updated}.`;
      if (autoAssigned > 0) msg += ` Auto-asignados: ${autoAssigned}.`;

      await createSyncNotificationForBusinessUsers({
        businessId,
        type: 'sync_insumos',
        title: 'Cambios detectados en insumos',
        message: msg,
        metadata: {
          source: 'maxi',
          scope: 'insumos',
          inserted,
          updated,
          unchanged,
          auto_assigned: autoAssigned,
          total_fetched: Array.isArray(raw) ? raw.length : null,
          business_name: businessName || null,
        },
      });
    }

    return {
      ok: true,
      businessId,
      total: normalized.length,
      inserted,
      updated,
      unchanged,
      autoAssigned,
    };

  } catch (e) {
    // Notificación de error (type permitido: 'error')
    await createSyncNotificationForBusinessUsers({
      businessId,
      type: 'error',
      title: 'Error sincronizando insumos',
      message: e?.message || 'Error desconocido',
      metadata: {
        source: 'maxi',
        scope: 'insumos',
        business_name: businessName || null,
      },
    }).catch(() => {});

    throw e;

  } finally {
    try { if (locked) await unlock(client, lockKey); } catch {}
    client.release();
  }
}

async function syncInsumosAllBusinesses({ req } = {}) {
  const startedAt = new Date().toISOString();
  const businesses = await listBusinessesWithMaxi();

  const out = {
    ok: true,
    scope: 'insumos',
    started_at: startedAt,
    total: businesses.length,
    success: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };

  for (const b of businesses) {
    try {
      const r = await syncOneBusinessInsumos({
        businessId: b.id,
        businessName: b.name,
        req,
      });

      if (r?.skipped) out.skipped++;
      else out.success++;

      out.details.push({ businessId: b.id, businessName: b.name, ...r });

    } catch (e) {
      out.failed++;
      out.details.push({ businessId: b.id, businessName: b.name, ok: false, error: e.message });
    }
  }

  return out;
}

module.exports = {
  syncInsumosAllBusinesses,
  syncOneBusinessInsumos,
};
