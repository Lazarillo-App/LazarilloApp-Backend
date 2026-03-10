// services/maxiRecetasService.js
'use strict';

/**
 * Sync de recetas desde MaxiRest.
 *
 * Endpoint: GET /estadisticasmaster/recetas
 * Headers:  Authorization: Bearer <token>
 *
 * Respuesta de MaxiRest:
 * {
 *   resultCode: 'SUCCESS',
 *   content: {
 *     cod_cli: 4607,
 *     recetas: [
 *       {
 *         artCode: 51,           → maxi_articles.articulo_id
 *         recName: "Fainá",
 *         recItems: [
 *           {
 *             insCode: 1,        → insumos.codigo_maxi
 *             insName: "Harina",
 *             insCant: 0.3,
 *             insUnit: "Kg",
 *             insObs: ""
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * }
 *
 * Estrategia de upsert:
 *   - Por cada receta: upsert en `recetas` por (article_id, business_id)
 *   - Por cada item: cruzar insCode → insumos.codigo_maxi → insumos.id
 *   - DELETE + INSERT de receta_items (reemplaza todo en cada sync)
 *   - Si el insumo no existe en la tabla insumos → guardar igual con insumo_id=null
 *     y guardar insCode + insName para no perder información
 */

const pool    = require('../config/db');
const { getBearer } = require('./maxiSalesService');

const MAXI_BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');
const RECETAS_PATH = '/estadisticasmaster/recetas';

const fetchNative =
  (typeof globalThis.fetch === 'function')
    ? ((...args) => globalThis.fetch(...args))
    : require('node-fetch');

// ── Fetch recetas desde MaxiRest ──────────────────────────────────────────────

async function fetchMaxiRecetas({ businessId, req }) {
  const bearer = await getBearer(businessId, req);
  const url    = `${MAXI_BASE}${RECETAS_PATH}`;

  console.log('[maxiRecetas] GET', url);

  const r = await fetchNative(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
    },
  });

  const txt = await r.text().catch(() => '');
  let j;
  try { j = JSON.parse(txt); } catch { j = null; }

  if (!r.ok || (j?.resultCode && j.resultCode !== 'SUCCESS')) {
    const err = new Error(j?.resultDescription || r.statusText || 'Error MaxiRest recetas');
    err.status = r.status || 502;
    err._maxi  = { status: r.status, url, bodyPreview: String(txt).slice(0, 300) };
    throw err;
  }

  // Estructura: content.recetas[]
  const recetas = j?.content?.recetas ?? j?.recetas ?? [];
  return Array.isArray(recetas) ? recetas : [];
}

// ── Normalizar una receta cruda de MaxiRest ───────────────────────────────────

function normalizeReceta(raw) {
  const artCode = Number(raw?.artCode ?? raw?.art_code ?? raw?.codart ?? 0);
  if (!artCode || !Number.isFinite(artCode)) return null;

  const recName = String(raw?.recName ?? raw?.rec_name ?? raw?.nombre ?? '').trim();

  const items = (Array.isArray(raw?.recItems) ? raw.recItems : [])
    .map(it => {
      const insCode = Number(it?.insCode ?? it?.ins_code ?? it?.codigo ?? 0);
      if (!insCode || !Number.isFinite(insCode)) return null;
      return {
        insCode:  String(insCode),
        insName:  String(it?.insName ?? it?.ins_name ?? it?.nombre ?? '').trim(),
        insCant:  Number(it?.insCant ?? it?.ins_cant ?? it?.cantidad ?? 0),
        insUnit:  String(it?.insUnit ?? it?.ins_unit ?? it?.unidad ?? 'u').trim(),
        insObs:   String(it?.insObs  ?? it?.ins_obs  ?? it?.notas  ?? '').trim(),
      };
    })
    .filter(Boolean);

  return { artCode, recName, items };
}

// ── Sync principal ────────────────────────────────────────────────────────────

async function syncRecetasFromMaxi({ businessId, req }) {
  // 1. Fetch desde MaxiRest
  const rawRecetas = await fetchMaxiRecetas({ businessId, req });
  if (!rawRecetas.length) {
    return { ok: true, summary: { total: 0, inserted: 0, updated: 0, items_saved: 0, skipped: 0 } };
  }

  // 2. Normalizar
  const recetas = rawRecetas.map(normalizeReceta).filter(Boolean);

  // 3. Precargar mapa codigo_maxi → insumo_id para resolver los items
  const { rows: insumoRows } = await pool.query(
    `SELECT id, codigo_maxi FROM insumos WHERE business_id = $1 AND estado = 'activo'`,
    [businessId]
  );
  const insumoByCode = new Map(insumoRows.map(r => [String(r.codigo_maxi), Number(r.id)]));

  // 4. Upsert en transacción
  const client = await pool.connect();
  let inserted = 0, updated = 0, items_saved = 0, skipped = 0;

  try {
    await client.query('BEGIN');

    for (const rec of recetas) {
      // Verificar que el artículo existe en maxi_articles
      const { rows: artRows } = await client.query(
        `SELECT articulo_id FROM maxi_articles WHERE business_id = $1 AND articulo_id = $2 LIMIT 1`,
        [businessId, rec.artCode]
      );
      if (!artRows.length) {
        console.warn(`[syncRecetas] artCode=${rec.artCode} no existe en maxi_articles, omitiendo`);
        skipped++;
        continue;
      }

      // Calcular costo total desde los items (precio_ref del insumo × cantidad)
      let costoTotal = 0;
      const itemsResolved = rec.items.map(it => {
        const insumoId = insumoByCode.get(it.insCode) ?? null;
        return { ...it, insumoId };
      });

      // Upsert receta
      const { rows: recetaRows } = await client.query(
        `INSERT INTO recetas
           (article_id, business_id, nombre, descripcion, porciones,
            porcentaje_venta, costo_total, active, origen, created_at, updated_at)
         VALUES ($1, $2, $3, '', 1, 0, $4, TRUE, 'maxi', NOW(), NOW())
         ON CONFLICT (article_id, business_id) DO UPDATE SET
           nombre      = EXCLUDED.nombre,
           costo_total = EXCLUDED.costo_total,
           active      = TRUE,
           origen      = 'maxi',
           updated_at  = NOW()
         RETURNING id, (xmax = 0) AS is_insert`,
        [rec.artCode, businessId, rec.recName || null, costoTotal]
      );

      const recetaId = recetaRows[0].id;
      if (recetaRows[0].is_insert) inserted++; else updated++;

      // Reemplazar items
      await client.query(`DELETE FROM receta_items WHERE receta_id = $1`, [recetaId]);

      for (let i = 0; i < itemsResolved.length; i++) {
        const it = itemsResolved[i];
        if (!it.insCant || it.insCant <= 0) continue;

        await client.query(
          `INSERT INTO receta_items
             (receta_id, insumo_id, codigo_maxi_insumo, nombre_insumo_maxi,
              cantidad, unidad, costo_unitario, notas, orden, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, NOW(), NOW())`,
          [
            recetaId,
            it.insumoId,      // puede ser null si el insumo no existe aún
            it.insCode,       // siempre guardamos el código por si el insumo llega después
            it.insName,       // nombre tal como viene de Maxi
            it.insCant,
            it.insUnit || 'u',
            it.insObs || null,
            i,
          ]
        );
        items_saved++;
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return {
    ok: true,
    summary: { total: recetas.length, inserted, updated, items_saved, skipped },
  };
}

module.exports = { fetchMaxiRecetas, syncRecetasFromMaxi };