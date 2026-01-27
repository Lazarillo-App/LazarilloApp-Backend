// services/syncInsumosDetectService.js
'use strict';

const pool = require('../config/db');
const { fetchMaxiInsumos, normalizarInsumosMaxi } = require('./maxiSuppliesService');

/** helpers */
const normStr = (v) => (v == null ? '' : String(v).trim());
const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function diffFields(canon, stg) {
  const diffs = {};

  // comparaciones "importantes"
  const checks = [
    ['nombre', normStr],
    ['rubro', normStr],
    ['unidad_med', normStr],
    ['precio_ref', numOrNull],
    ['costo_ref', numOrNull],
    ['iva', normStr],
  ];

  for (const [k, fn] of checks) {
    const a = fn(canon?.[k]);
    const b = fn(stg?.[k]);
    // comparar numérico con tolerancia
    if (typeof a === 'number' || typeof b === 'number') {
      const aa = a ?? null;
      const bb = b ?? null;
      if (aa === null && bb === null) continue;
      if (aa === null || bb === null || Math.abs(aa - bb) > 0.0001) {
        diffs[k] = { from: aa, to: bb };
      }
    } else {
      if (a !== b) diffs[k] = { from: a, to: b };
    }
  }

  return diffs;
}

/**
 * Upsert staging maxi_supplies
 * Asumo columnas típicas: business_id, codigo, nombre, rubro, medida, precio, raw, updated_at
 * Ajustá nombres si tu tabla difiere.
 */
async function upsertMaxiSuppliesStaging(client, businessId, normalizedItems, sourceMeta) {
  if (!normalizedItems.length) return { upserted: 0 };

  const bizArr = [];
  const codArr = [];
  const nomArr = [];
  const rubArr = [];
  const medArr = [];
  const preArr = [];
  const ivaArr = [];
  const impArr = [];
  const disArr = [];
  const rawArr = [];

  for (const it of normalizedItems) {
    bizArr.push(Number(businessId));
    codArr.push(Number(it.codigo));
    nomArr.push(it.nombre || null);
    rubArr.push(it.rubro != null ? Number(it.rubro) : null);
    medArr.push(it.medida || null);
    preArr.push(it.precio != null ? Number(it.precio) : null);
    ivaArr.push(it.iva != null ? String(it.iva) : null);
    impArr.push(it.imp_int != null ? Number(it.imp_int) : null);
    disArr.push(!!it.discontinuado);
    rawArr.push(JSON.stringify({ ...it.raw, _source: sourceMeta }));
  }

  await client.query(`
    INSERT INTO maxi_supplies
      (business_id, codigo, nombre, rubro, medida, precio, iva, imp_int, discontinuado, raw, updated_at)
    SELECT * FROM UNNEST(
      $1::bigint[],
      $2::int[],
      $3::text[],
      $4::int[],
      $5::text[],
      $6::numeric[],
      $7::text[],
      $8::numeric[],
      $9::boolean[],
      $10::jsonb[],
      ARRAY(SELECT now() FROM generate_series(1, $11))
    )
    ON CONFLICT (business_id, codigo) DO UPDATE SET
      nombre        = EXCLUDED.nombre,
      rubro         = EXCLUDED.rubro,
      medida        = EXCLUDED.medida,
      precio        = EXCLUDED.precio,
      iva           = EXCLUDED.iva,
      imp_int       = EXCLUDED.imp_int,
      discontinuado = EXCLUDED.discontinuado,
      raw           = EXCLUDED.raw,
      updated_at    = now()
  `, [
    bizArr, codArr, nomArr, rubArr, medArr, preArr, ivaArr, impArr, disArr, rawArr, normalizedItems.length
  ]);

  return { upserted: normalizedItems.length };
}

/**
 * Detecta cambios en insumos y crea change_set + notificación
 */
async function detectInsumosChanges({ businessId, userId, req }) {
  const bid = Number(businessId);
  if (!Number.isFinite(bid) || bid <= 0) throw new Error('businessId inválido');

  const client = await pool.connect();
  let changeSetId = null;

  // Política default
  const defaultPolicy = {
    auto_apply_new: false,
    auto_apply_updates: false,
    allow_deletes: false,
    max_missing_percent: 5,
    block_if_less_than_count: 0, // ej 800
  };

  try {
    await client.query('BEGIN');

    // 0) policy
    const polRes = await client.query(
      `SELECT policies FROM sync_policies WHERE business_id = $1`,
      [bid]
    );
    const policies = polRes.rows?.[0]?.policies || {};
    const p = { ...defaultPolicy, ...(policies?.insumos || {}) };

    // 1) Canonical count actual
    const canonCountRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM insumos WHERE business_id = $1 AND activo = true`,
      [bid]
    );
    const canonicalCount = canonCountRes.rows[0]?.n ?? 0;

    // 2) Fetch Maxi + normalize
    const raw = await fetchMaxiInsumos({ businessId: bid, req });
    const normalized = normalizarInsumosMaxi(raw);

    const incomingCount = normalized.length;

    // 3) Guardrails por conteo
    const missingPercent = canonicalCount > 0
      ? Math.max(0, ((canonicalCount - incomingCount) / canonicalCount) * 100)
      : 0;

    const riskReasons = [];
    let blocked = false;

    if (p.block_if_less_than_count && incomingCount < Number(p.block_if_less_than_count)) {
      blocked = true;
      riskReasons.push(`incoming_count_below_threshold(${incomingCount} < ${p.block_if_less_than_count})`);
    }

    if (canonicalCount > 0 && missingPercent > Number(p.max_missing_percent || 0)) {
      // ojo: esto detecta "se vino abajo Maxi"
      blocked = true;
      riskReasons.push(`missing_percent_exceeded(${missingPercent.toFixed(2)}% > ${p.max_missing_percent}%)`);
    }

    // 4) Upsert staging siempre (para auditoría)
    const sourceMeta = { provider: 'maxirest', endpoint: '/estadisticasmaster/insumos', fetched_at: new Date().toISOString() };
    await upsertMaxiSuppliesStaging(client, bid, normalized, sourceMeta);

    // 5) Leer staging vs canonical para diff
    // staging map
    const stgRes = await client.query(
      `SELECT codigo, nombre, rubro, medida, precio
       FROM maxi_supplies
       WHERE business_id = $1`,
      [bid]
    );
    const stgByCode = new Map(stgRes.rows.map(r => [Number(r.codigo), r]));

    // canonical map
    const canonRes = await client.query(
      `SELECT codigo_maxi, nombre, rubro, unidad_med, precio_ref, costo_ref, nota, iva
       FROM insumos
       WHERE business_id = $1`,
      [bid]
    );
    const canonByCode = new Map(
      canonRes.rows
        .filter(r => r.codigo_maxi != null)
        .map(r => [Number(r.codigo_maxi), r])
    );

    const changes = [];
    let newCount = 0, updCount = 0, missingCount = 0;

    // new + update
    for (const [code, stg] of stgByCode.entries()) {
      const canon = canonByCode.get(code);

      if (!canon) {
        newCount++;
        changes.push({
          entity: 'insumo',
          entity_id: `codigo_maxi:${code}`,
          action: 'create',
          risk: blocked ? 'block' : 'low',
          fields: {
            codigo_maxi: { from: null, to: String(code) },
            nombre: { from: null, to: normStr(stg.nombre) },
            rubro: { from: null, to: normStr(stg.rubro) },
            unidad_med: { from: null, to: normStr(stg.medida) },
            precio_ref: { from: null, to: numOrNull(stg.precio) },
          },
          source: { provider: 'maxirest', endpoint: '/estadisticasmaster/insumos' }
        });
        continue;
      }

      const canonShape = {
        nombre: canon.nombre,
        rubro: canon.rubro,
        unidad_med: canon.unidad_med,
        precio_ref: canon.precio_ref,
        costo_ref: canon.costo_ref,
        iva: canon.iva,
      };
      const stgShape = {
        nombre: stg.nombre,
        rubro: stg.rubro,
        unidad_med: stg.medida,
        precio_ref: stg.precio,
        costo_ref: null,
        iva: null,
      };

      const diffs = diffFields(canonShape, stgShape);
      if (Object.keys(diffs).length) {
        updCount++;
        changes.push({
          entity: 'insumo',
          entity_id: `codigo_maxi:${code}`,
          action: 'update',
          risk: blocked ? 'block' : 'medium',
          fields: diffs,
          source: { provider: 'maxirest', endpoint: '/estadisticasmaster/insumos' }
        });
      }
    }

    // missing (existe en canonical pero no en staging)
    for (const [code, canon] of canonByCode.entries()) {
      if (!stgByCode.has(code)) {
        missingCount++;
        changes.push({
          entity: 'insumo',
          entity_id: `codigo_maxi:${code}`,
          action: 'missing',
          risk: 'high',
          fields: {
            codigo_maxi: { from: String(code), to: null },
            nombre: { from: normStr(canon.nombre), to: null },
          },
          source: { provider: 'maxirest', endpoint: '/estadisticasmaster/insumos' }
        });
      }
    }

    // 6) Crear change_set
    const status = blocked ? 'error' : 'pending';
    const summary = {
      counts: { new: newCount, updated: updCount, missing: missingCount, incoming: incomingCount, canonical: canonicalCount },
      risk: { blocked, reasons: riskReasons, missingPercent: Number(missingPercent.toFixed(2)) },
    };

    const csRes = await client.query(`
      INSERT INTO sync_change_sets
        (business_id, scope, status, created_by, summary, changes, source_snapshot)
      VALUES ($1, 'insumos', $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
      RETURNING id
    `, [
      bid,
      blocked ? 'error' : 'pending',
      userId || null,
      JSON.stringify(summary),
      JSON.stringify(changes),
      JSON.stringify({ source: sourceMeta, sample_count: incomingCount })
    ]);

    changeSetId = csRes.rows[0].id;

    // 7) Crear notificación
    const title = blocked
      ? 'Sync Insumos BLOQUEADA (Maxi inconsistente)'
      : 'Cambios detectados en Insumos (requiere aprobación)';

    const message = blocked
      ? `Maxi devolvió ${incomingCount} insumos vs ${canonicalCount} en DB. Se bloqueó por seguridad.`
      : `Nuevos: ${newCount}, Actualizaciones: ${updCount}, Faltantes en Maxi: ${missingCount}.`;

    await client.query(`
      INSERT INTO sync_notifications (business_id, user_id, type, title, message, metadata, read)
      VALUES ($1, $2, 'sync_articles', $3, $4, $5::jsonb, false)
    `, [
      bid,
      userId || 1,
      title,
      message,
      JSON.stringify({ change_set_id: changeSetId, scope: 'insumos', ...summary })
    ]);

    await client.query('COMMIT');

    return { ok: true, change_set_id: changeSetId, status, summary };

  } catch (e) {
    await client.query('ROLLBACK');
    // si ya creamos changeSetId, marcarlo como error (best effort)
    if (changeSetId) {
      try {
        await client.query(
          `UPDATE sync_change_sets SET status='error', error=$2 WHERE id=$1`,
          [changeSetId, String(e.message || e)]
        );
      } catch {}
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { detectInsumosChanges };
