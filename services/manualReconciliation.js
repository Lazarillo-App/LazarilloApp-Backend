'use strict';

const pool = require('../config/db');

/**
 * Servicio de reconciliación entre artículos manuales (id negativo) y
 * artículos de MaxiRest (id positivo) que se sincronizan después.
 *
 * Match strategy: nombre + rubro (categoria DB) + subrubro normalizados
 *   (lower, sin tildes, espacios colapsados). NO se usa precio como filtro.
 *
 * Resultados:
 *   0 candidatos → no hace nada (el manual sigue siendo manual).
 *   1 candidato  → reconciliación automática (mode='auto', status='done').
 *   2+ candidatos → status='pending', usuario elige por modal.
 */

// ───────────────────────────────────────────────────────────────────────
// Helpers de normalización
// ───────────────────────────────────────────────────────────────────────

function normKey(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca tildes/diacríticos
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function matchKey({ nombre, categoria, subrubro }) {
  return [normKey(nombre), normKey(categoria), normKey(subrubro)].join('|');
}

// ───────────────────────────────────────────────────────────────────────
// Match: encuentra para cada manual los candidatos Maxi
// ───────────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<Array<{ manual: object, candidates: object[] }>>}
 */
async function findMatches(client, bizId) {
  const { rows } = await client.query(
    `SELECT articulo_id, nombre, categoria, subrubro, precio
       FROM maxi_articles
      WHERE business_id = $1`,
    [bizId]
  );

  const manuals = [];
  const positivesByKey = new Map();

  for (const r of rows) {
    const id = Number(r.articulo_id);
    if (id < 0) {
      manuals.push(r);
    } else if (id > 0) {
      const k = matchKey(r);
      if (!positivesByKey.has(k)) positivesByKey.set(k, []);
      positivesByKey.get(k).push(r);
    }
  }

  return manuals.map(m => ({
    manual: m,
    candidates: positivesByKey.get(matchKey(m)) || [],
  }));
}

// ───────────────────────────────────────────────────────────────────────
// Apply: migra todas las FKs del negID al posID y borra el manual
// ───────────────────────────────────────────────────────────────────────

/**
 * Hace la migración transaccional. NO abre/cierra transacción por sí misma —
 * el caller debe estar dentro de BEGIN/COMMIT.
 *
 * Política de conflictos: cuando hay UNIQUE (manual y positivo ya conviven
 * en el mismo grupo/lista/scope), gana lo del manual (porque es lo que el
 * usuario cargó). Borramos primero la fila del positivo, después UPDATE.
 */
async function applyReconciliation(client, bizId, manualId, maxiId) {
  // 1) recetas — UNIQUE (article_id, business_id)
  await client.query(
    `DELETE FROM recetas WHERE article_id = $1 AND business_id = $2`,
    [maxiId, bizId]
  );
  await client.query(
    `UPDATE recetas SET article_id = $1
      WHERE article_id = $2 AND business_id = $3`,
    [maxiId, manualId, bizId]
  );

  // 2) article_link_members — UNIQUE (link_group_id, article_id)
  //    Si el positivo ya está en algún grupo donde está el manual, dejamos
  //    el del manual y borramos el del positivo.
  await client.query(
    `DELETE FROM article_link_members
      WHERE business_id = $1
        AND article_id = $2
        AND link_group_id IN (
          SELECT link_group_id FROM article_link_members
           WHERE business_id = $1 AND article_id = $3
        )`,
    [bizId, maxiId, manualId]
  );
  await client.query(
    `UPDATE article_link_members SET article_id = $1
      WHERE article_id = $2 AND business_id = $3`,
    [maxiId, manualId, bizId]
  );

  // 3) article_list_items — UNIQUE (list_id, article_id)
  await client.query(
    `DELETE FROM article_list_items
      WHERE article_id = $1
        AND list_id IN (
          SELECT list_id FROM article_list_items WHERE article_id = $2
        )`,
    [maxiId, manualId]
  );
  await client.query(
    `UPDATE article_list_items SET article_id = $1 WHERE article_id = $2`,
    [maxiId, manualId]
  );

  // 4) article_price_config — PK (business_id, scope, scope_id), scope_id TEXT
  await client.query(
    `DELETE FROM article_price_config
      WHERE business_id = $1 AND scope = 'articulo' AND scope_id = $2`,
    [bizId, String(maxiId)]
  );
  await client.query(
    `UPDATE article_price_config SET scope_id = $1
      WHERE business_id = $2 AND scope = 'articulo' AND scope_id = $3`,
    [String(maxiId), bizId, String(manualId)]
  );

  // 5) agrupaciones.app_articles_ids (jsonb array de ints, legacy)
  //    Iteramos en JS para mantener la query simple y evitar duplicados.
  const { rows: agsLegacy } = await client.query(
    `SELECT id, app_articles_ids FROM agrupaciones
      WHERE business_id = $1
        AND app_articles_ids IS NOT NULL
        AND app_articles_ids @> to_jsonb($2::int)`,
    [bizId, manualId]
  );
  for (const ag of agsLegacy) {
    const raw = Array.isArray(ag.app_articles_ids)
      ? ag.app_articles_ids
      : (typeof ag.app_articles_ids === 'string' ? JSON.parse(ag.app_articles_ids || '[]') : []);
    const ids = new Set(raw.map(Number).filter(n => Number.isFinite(n) && n !== manualId));
    ids.add(maxiId);
    await client.query(
      `UPDATE agrupaciones
          SET app_articles_ids = $1::jsonb, updated_at = NOW()
        WHERE id = $2`,
      [JSON.stringify(Array.from(ids)), ag.id]
    );
  }

  // 6) agrupaciones.articulos (jsonb de objetos {id, ...})
  const { rows: ags } = await client.query(
    `SELECT id, articulos FROM agrupaciones
      WHERE business_id = $1
        AND articulos IS NOT NULL
        AND articulos @> jsonb_build_array(jsonb_build_object('id', $2::int))`,
    [bizId, manualId]
  );
  for (const ag of ags) {
    const arts = Array.isArray(ag.articulos) ? ag.articulos : [];
    const hasPos = arts.some(a => Number(a?.id) === maxiId);
    const nuevos = hasPos
      ? arts.filter(a => Number(a?.id) !== manualId)
      : arts.map(a => Number(a?.id) === manualId ? { ...a, id: maxiId } : a);
    await client.query(
      `UPDATE agrupaciones SET articulos = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(nuevos), ag.id]
    );
  }

  // 7) Borrar el manual de maxi_articles y app_articles
  //    (el posID ya existe en ambas, traído por el sync de Maxi)
  await client.query(
    `DELETE FROM maxi_articles WHERE business_id = $1 AND articulo_id = $2`,
    [bizId, manualId]
  );
  await client.query(
    `DELETE FROM app_articles WHERE id = $1 AND business_id = $2`,
    [manualId, bizId]
  );
}

// ───────────────────────────────────────────────────────────────────────
// Orquestador: corre después del sync de Maxi
// ───────────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{reconciled: number, pending: number, none: number, errors: number, items: Array}>}
 *   `items` es el detalle (útil para la notificación al frontend).
 */
async function reconcileManualsAfterSync(bizId) {
  const summary = { reconciled: 0, pending: 0, none: 0, errors: 0, items: [] };
  const client = await pool.connect();
  try {
    const matches = await findMatches(client, bizId);
    if (matches.length === 0) return summary;

    for (const { manual, candidates } of matches) {
      const manualId = Number(manual.articulo_id);

      // Si ya hay un 'done' previo para este manual_id, saltar (no debería
      // pasar porque el manual ya no existiría, pero por las dudas).
      const { rows: doneRows } = await client.query(
        `SELECT id FROM manual_reconciliations
          WHERE business_id = $1 AND manual_id_old = $2 AND status = 'done'
          LIMIT 1`,
        [bizId, manualId]
      );
      if (doneRows.length) continue;

      // ¿Hay un 'pending' previo para este manual? Lo reciclamos en vez de duplicar.
      const { rows: pendingRows } = await client.query(
        `SELECT id FROM manual_reconciliations
          WHERE business_id = $1 AND manual_id_old = $2 AND status = 'pending'
          LIMIT 1`,
        [bizId, manualId]
      );
      const existingPendingId = pendingRows[0]?.id || null;

      // CASO 1: sin candidatos → nada que hacer
      if (candidates.length === 0) {
        summary.none++;
        // Si había un pending pero ahora no hay candidatos (alguien borró el match),
        // lo dejamos pendiente igual: que el usuario decida.
        continue;
      }

      // CASO 2: candidato único → reconciliación automática
      if (candidates.length === 1) {
        const pos = candidates[0];
        try {
          await client.query('BEGIN');
          await applyReconciliation(client, bizId, manualId, Number(pos.articulo_id));

          if (existingPendingId) {
            await client.query(
              `UPDATE manual_reconciliations
                  SET maxi_id_new = $1, precio_maxi = $2,
                      status = 'done', mode = 'auto',
                      candidates = '[]'::jsonb, resolved_at = NOW()
                WHERE id = $3`,
              [Number(pos.articulo_id), pos.precio, existingPendingId]
            );
          } else {
            await client.query(
              `INSERT INTO manual_reconciliations
                 (business_id, manual_id_old, maxi_id_new, nombre, rubro, subrubro,
                  precio_manual, precio_maxi, status, mode, resolved_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'done', 'auto', NOW())`,
              [bizId, manualId, Number(pos.articulo_id),
               manual.nombre, manual.categoria, manual.subrubro,
               manual.precio, pos.precio]
            );
          }

          await client.query('COMMIT');
          summary.reconciled++;
          summary.items.push({
            manualId, maxiId: Number(pos.articulo_id),
            nombre: manual.nombre,
            precioManual: manual.precio, precioMaxi: pos.precio,
            mode: 'auto',
          });
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch { /* */ }
          console.error(`[reconcile] error manual=${manualId}:`, e.message);
          summary.errors++;
        }
        continue;
      }

      // CASO 3: ambiguo → pending
      const candPayload = candidates.map(c => ({
        id: Number(c.articulo_id),
        nombre: c.nombre,
        precio: c.precio != null ? Number(c.precio) : null,
      }));

      try {
        if (existingPendingId) {
          await client.query(
            `UPDATE manual_reconciliations
                SET candidates = $1::jsonb
              WHERE id = $2`,
            [JSON.stringify(candPayload), existingPendingId]
          );
        } else {
          await client.query(
            `INSERT INTO manual_reconciliations
               (business_id, manual_id_old, nombre, rubro, subrubro,
                precio_manual, candidates, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending')`,
            [bizId, manualId,
             manual.nombre, manual.categoria, manual.subrubro,
             manual.precio, JSON.stringify(candPayload)]
          );
        }
        summary.pending++;
        summary.items.push({
          manualId, candidates: candPayload, status: 'pending',
        });
      } catch (e) {
        console.error(`[reconcile] error registrando pending manual=${manualId}:`, e.message);
        summary.errors++;
      }
    }
  } finally {
    client.release();
  }
  return summary;
}

module.exports = {
  // Públicos
  reconcileManualsAfterSync,
  applyReconciliation,
  // Para tests / endpoints futuros
  findMatches,
  matchKey,
  normKey,
};