'use strict';

const pool = require('../config/db');
const { fetchMaxiInsumos, normalizarInsumosMaxi } = require('./maxiSuppliesService');
const { upsertFromMaxi } = require('../repos/insumosRepo');
const { autoAssignNewInsumos } = require('./autoAssignNewInsumos');
const { createSyncNotificationForBusinessUsers } = require('./notificationService');

function lockKeyFor(businessId) {
  // cualquier int64 determinístico sirve; que sea estable y único por business
  return 0x1A5A0 ^ Number(businessId);
}

async function tryLock(client, businessId) {
  const { rows } = await client.query(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [lockKeyFor(businessId)]
  );
  return !!rows?.[0]?.locked;
}

async function unlock(client, businessId) {
  await client.query('SELECT pg_advisory_unlock($1)', [lockKeyFor(businessId)]);
}

async function listBusinessesWithMaxi() {
  const { rows } = await pool.query(`
    SELECT id
    FROM app_businesses
    WHERE (props->'maxi'->>'email') IS NOT NULL
      AND (props->'maxi'->>'codcli') IS NOT NULL
      AND (props->'maxi' ? 'pass_enc' OR props->'maxi' ? 'pass' OR props->'maxi' ? 'password')
    ORDER BY id
  `);
  return rows.map(r => Number(r.id)).filter(Number.isFinite);
}

async function syncOneBusinessInsumos({ businessId, req = null } = {}) {
  const bizId = Number(businessId);
  if (!Number.isFinite(bizId) || bizId <= 0) throw new Error('invalid_business_id');

  const client = await pool.connect();
  let locked = false;

  try {
    // lock en una tx cortita
    await client.query('BEGIN');
    locked = await tryLock(client, bizId);
    if (!locked) {
      await client.query('ROLLBACK');
      return { ok: false, skipped: true, reason: 'locked' };
    }
    await client.query('COMMIT');

    // fetch Maxi (fuera de tx)
    const raw = await fetchMaxiInsumos({ businessId: bizId, req });
    const norm = normalizarInsumosMaxi(raw);

    const summary = await upsertFromMaxi(bizId, norm, { useIncomingEstado: true });

    const changed = (summary.inserted || 0) + (summary.updated || 0);

    // notificación (1 por user del negocio)
    if (changed > 0) {
      await createSyncNotificationForBusinessUsers({
        businessId: bizId,
        type: 'sync_insumos',
        title: 'Cambios detectados en insumos',
        message: `Insertados: ${summary.inserted || 0}, Actualizados: ${summary.updated || 0}.`,
        metadata: {
          source: 'maxi',
          scope: 'insumos',
          inserted: summary.inserted || 0,
          updated: summary.updated || 0,
        },
        actorUserId: null, // cron
      });
    }

    // auto-assign silencioso
    await autoAssignNewInsumos(bizId).catch(() => {});

    return { ok: true, businessId: bizId, fetched: raw.length, ...summary };
  } finally {
    try { if (locked) await unlock(client, bizId); } catch {}
    client.release();
  }
}

async function syncInsumosAllBusinesses({ req = null } = {}) {
  const ids = await listBusinessesWithMaxi();

  let ok = 0, fail = 0, skipped = 0;
  const details = [];

  for (const id of ids) {
    try {
      const out = await syncOneBusinessInsumos({ businessId: id, req });
      if (out?.skipped) skipped++;
      else ok++;
      details.push({ businessId: id, ok: true, ...out });
    } catch (e) {
      fail++;
      details.push({ businessId: id, ok: false, error: e.message });
    }
  }

  return { ran: ids.length, ok_count: ok, fail_count: fail, skipped_count: skipped, details };
}

module.exports = { syncInsumosAllBusinesses, syncOneBusinessInsumos };
