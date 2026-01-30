// services/sync/articlesSyncPolicy.js
'use strict';

const pool = require('../../config/db');
const { importMaxiMenuForBusiness } = require('../maxiMenuService');
const { createSyncNotificationForBusinessUsers } = require('../notificationService');

function lockKeyForArticles(businessId) {
  // Key estable distinta a insumos para evitar colisiones
  return (0x2B7E1 ^ Number(businessId)) | 0;
}

async function tryLock(client, key) {
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
  return !!rows?.[0]?.locked;
}

async function unlock(client, key) {
  await client.query('SELECT pg_advisory_unlock($1)', [key]);
}

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
      AND deleted_at IS NULL
    ORDER BY id
  `);

  return rows
    .map(r => ({ id: Number(r.id), name: r.name || null }))
    .filter(x => Number.isFinite(x.id) && x.id > 0);
}

async function syncOneBusinessArticles({ businessId, businessName, req }) {
  const client = await pool.connect();
  const lockKey = lockKeyForArticles(businessId);
  let locked = false;

  try {
    locked = await tryLock(client, lockKey);
    if (!locked) {
      return { ok: false, skipped: true, reason: 'locked' };
    }

    // ✅ Tu service ya hace: fetchMenu + flatten + upsert
    const result = await importMaxiMenuForBusiness(businessId, { req });

    const imported = Number(result?.imported_articles || 0);

    // Notificar solo si hubo artículos (si vino 0, normalmente es porque Maxi devolvió vacío)
    if (imported > 0) {
      await createSyncNotificationForBusinessUsers({
        businessId,
        type: 'sync_articles', // ✅ permitido en ALLOWED_TYPES
        title: 'Artículos sincronizados',
        message: `Se importaron/actualizaron ${imported} artículos desde Maxi.`,
        metadata: {
          source: 'maxi',
          scope: 'articles',
          imported_articles: imported,
          business_name: businessName || null,
        }
      });
    }

    return {
      ok: true,
      businessId,
      imported_articles: imported,
    };

  } catch (e) {
    // ✅ type 'error' existe en ALLOWED_TYPES
    await createSyncNotificationForBusinessUsers({
      businessId,
      type: 'error',
      title: 'Error sincronizando artículos',
      message: e?.message || 'Error desconocido',
      metadata: { scope: 'articles', source: 'maxi', business_name: businessName || null }
    }).catch(() => {});

    throw e;

  } finally {
    try { if (locked) await unlock(client, lockKey); } catch {}
    client.release();
  }
}

async function syncArticlesAllBusinesses({ req } = {}) {
  const startedAt = new Date().toISOString();
  const businesses = await listBusinessesWithMaxi();

  const out = {
    ok: true,
    scope: 'articles',
    started_at: startedAt,
    total: businesses.length,
    success: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };

  for (const b of businesses) {
    try {
      const r = await syncOneBusinessArticles({
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
  syncArticlesAllBusinesses,
  syncOneBusinessArticles,
};
