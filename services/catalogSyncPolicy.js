// services/catalogSyncPolicy.js
'use strict';

const pool = require('../config/db');
const { fetchInsumosRubrosFromMaxi, fetchInsumosFromMaxi } = require('./maxiCatalogService');
const { upsertRubros, upsertInsumos } = require('./catalogStore');
const { createNotification } = require('./notificationsService'); // o tu manera actual

function lockKeyFor(businessId) { return 0xCA7A10 ^ Number(businessId); }

async function tryLock(client, businessId) {
  const { rows: [{ locked }] } = await client.query(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [lockKeyFor(businessId)]
  );
  return !!locked;
}
async function unlock(client, businessId) {
  await client.query('SELECT pg_advisory_unlock($1)', [lockKeyFor(businessId)]);
}

async function syncCatalogForBusiness({ businessId, req } = {}) {
  if (!businessId) throw new Error('businessId requerido');

  const client = await pool.connect();
  let locked = false;

  try {
    await client.query('BEGIN');
    locked = await tryLock(client, businessId);
    if (!locked) {
      await client.query('ROLLBACK');
      return { ok: false, skipped: true, reason: 'locked' };
    }
    await client.query('COMMIT'); // liberamos transacción antes de hablar con Maxi

    // 1) Traer de Maxi
    const [rubrosRaw, insumosRaw] = await Promise.all([
      fetchInsumosRubrosFromMaxi({ businessId, req }),
      fetchInsumosFromMaxi({ businessId, req }),
    ]);

    // 2) Persistir + detectar cambios
    const rubrosRes = await upsertRubros(businessId, rubrosRaw);   // { inserted, updated, unchanged }
    const insumosRes = await upsertInsumos(businessId, insumosRaw);

    // 3) Notificaciones (solo si hay cambios)
    const changes =
      (rubrosRes.inserted + rubrosRes.updated + insumosRes.inserted + insumosRes.updated);

    if (changes > 0) {
      await createNotification({
        businessId,
        type: 'sync_catalog',
        title: 'Cambios detectados en Maxi',
        body: {
          rubros: rubrosRes,
          insumos: insumosRes,
        },
      });
    }

    return { ok: true, rubros: rubrosRes, insumos: insumosRes };
  } finally {
    try {
      if (locked) {
        const c2 = await pool.connect();
        try { await unlock(c2, businessId); } finally { c2.release(); }
      }
    } catch {}
    client.release();
  }
}

module.exports = { syncCatalogForBusiness };
