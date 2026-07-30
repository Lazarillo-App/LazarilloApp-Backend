// controllers/onboardingController.js
// Endpoints de alta masiva para el Asistente de onboarding (Anthony).
// Reciben datos YA parseados en JSON (no archivos) y los persisten en las
// mismas tablas que usa el ABM manual, respetando todas las convenciones:
//   - ID negativo secuencial (no choca con IDs de MaxiRest, positivos)
//   - Doble escritura: app_articles + maxi_articles (para que aparezca en el árbol)
//   - Inversión rubro/subrubro: en maxi_articles → subrubro DB = "Rubro" UI, categoria DB = "Subrubro" UI
//   - Taxonomía FK: crea filas en categorias/subrubros para categoria_id/subrubro_id
//   - Storage en el principal de la org (subnegocios comparten catálogo)
//   - origen = 'onboarding' (ya contemplado en resolveSalesBizId y afines)
'use strict';

const pool = require('../config/db');
const { invalidateCacheForBiz } = require('../middleware/cacheJson');

/* ───────────── Helpers (espejo de articulosABMController) ───────────── */

function getBusinessId(req) {
  const ctx = Number(req.businessId);
  if (Number.isFinite(ctx)) return ctx;
  const p = Number(req.params?.businessId ?? req.params?.id);
  if (Number.isFinite(p)) return p;
  const h = Number(req.header('X-Business-Id'));
  if (Number.isFinite(h)) return h;
  return NaN;
}

function parsePrecio(v) {
  if (v == null || v === '') return 0;
  const s = String(v).trim().replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

async function resolveStorageBizId(bizId) {
  const { rows } = await pool.query(
    `SELECT organization_id FROM app_businesses WHERE id = $1`, [bizId]
  );
  if (!rows[0]?.organization_id) return bizId;
  const { rows: pRows } = await pool.query(
    `SELECT id FROM app_businesses
      WHERE organization_id = $1 AND created_from != 'from_group'
      ORDER BY created_at ASC LIMIT 1`,
    [rows[0].organization_id]
  );
  return pRows[0]?.id ? Number(pRows[0].id) : bizId;
}

/* ══════════════════════════════════════════════════════════════════════════
   POST /api/businesses/:businessId/onboarding/articulos-bulk
   Body: { articulos: [ { nombre, precioVenta, rubro, subRubro, descripcion? } ] }
══════════════════════════════════════════════════════════════════════════ */
exports.articulosBulk = async (req, res, next) => {
  const bizId = getBusinessId(req);
  if (!Number.isFinite(bizId)) {
    return res.status(400).json({ ok: false, error: 'businessId inválido' });
  }

  const arr = Array.isArray(req.body?.articulos) ? req.body.articulos : [];
  if (!arr.length) {
    return res.status(400).json({ ok: false, error: 'articulos_vacio', message: 'No se recibieron artículos' });
  }

  const items = arr
    .map((a) => ({
      nombre: String(a?.nombre ?? '').trim(),
      precio: parsePrecio(a?.precioVenta ?? a?.precio),
      rubro: String(a?.rubro ?? '').trim(),
      subrubro: String(a?.subRubro ?? a?.subrubro ?? '').trim(),
      descripcion: String(a?.descripcion ?? '').trim() || null,
    }))
    .filter((a) => a.nombre);

  if (!items.length) {
    return res.status(400).json({ ok: false, error: 'sin_nombres', message: 'Ningún artículo tiene nombre' });
  }

  const storageBizId = await resolveStorageBizId(bizId);
  const batchId = `onboarding-${new Date().toISOString().slice(0, 10)}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Taxonomía: resolver categorias/subrubros una vez por valor único ──
    const categoriaIdByRubro = new Map();
    const subrubroIdByKey = new Map();

    const rubrosUnicos = [...new Set(items.map((it) => it.rubro).filter(Boolean))];
    for (const ru of rubrosUnicos) {
      let { rows: catRows } = await client.query(
        `SELECT id FROM categorias WHERE nombre = $1`, [ru]
      );
      let categoriaId;
      if (catRows.length) {
        categoriaId = catRows[0].id;
      } else {
        const ins = await client.query(
          `INSERT INTO categorias (nombre) VALUES ($1) RETURNING id`, [ru]
        );
        categoriaId = ins.rows[0].id;
      }
      categoriaIdByRubro.set(ru, categoriaId);
    }

    for (const it of items) {
      if (!it.rubro || !it.subrubro) continue;
      const key = it.rubro + '||' + it.subrubro;
      if (subrubroIdByKey.has(key)) continue;
      const categoriaId = categoriaIdByRubro.get(it.rubro);
      if (!categoriaId) continue;
      let { rows: subRows } = await client.query(
        `SELECT id FROM subrubros WHERE categoria_id = $1 AND nombre = $2`,
        [categoriaId, it.subrubro]
      );
      let subrubroId;
      if (subRows.length) {
        subrubroId = subRows[0].id;
      } else {
        const ins = await client.query(
          `INSERT INTO subrubros (categoria_id, nombre) VALUES ($1, $2) RETURNING id`,
          [categoriaId, it.subrubro]
        );
        subrubroId = ins.rows[0].id;
      }
      subrubroIdByKey.set(key, subrubroId);
    }

    // ── 2. Reservar rango de IDs negativos ──
    const { rows: minRows } = await client.query(
      `SELECT COALESCE(MIN(id), 0) - 1 AS next_id FROM app_articles WHERE id < 0`
    );
    let nextId = Math.min(Number(minRows[0].next_id), -1);

    let inserted = 0;

    // ── 3. Insertar cada artículo ──
    for (const it of items) {
      const newId = nextId;
      nextId -= 1;

      const categoriaId = it.rubro ? (categoriaIdByRubro.get(it.rubro) || 1) : 1;
      const subrubroId = (it.rubro && it.subrubro)
        ? (subrubroIdByKey.get(it.rubro + '||' + it.subrubro) || 1)
        : 1;

      const skuFinal = `L${String(Math.abs(newId)).padStart(3, '0')}`;

      await client.query(
        `INSERT INTO app_articles
           (id, business_id, name, rubro, subrubro, node_type, price, categoria_id, subrubro_id, codigo, props, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'item', $6, $7, $8, $9, $10, NOW())`,
        [
          newId, storageBizId, it.nombre,
          it.rubro || null, it.subrubro || null,
          it.precio, categoriaId, subrubroId, skuFinal,
          JSON.stringify({
            origen: 'onboarding', sku: skuFinal, codigo_externo: null,
            sin_equivalencia: true, descripcion: it.descripcion,
          }),
        ]
      );

      // maxi_articles: INVERSIÓN subrubro DB = "Rubro" UI, categoria DB = "Subrubro" UI
      const maxiCategoria = it.subrubro || null;
      const maxiSubrubro = it.rubro || null;
      await client.query(
        `INSERT INTO maxi_articles
           (business_id, articulo_id, nombre, categoria, subrubro, precio, costo, raw, origen, upload_batch_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0, '{}'::jsonb, 'onboarding', $7, NOW())
         ON CONFLICT (business_id, articulo_id) DO UPDATE SET
           nombre          = EXCLUDED.nombre,
           categoria       = EXCLUDED.categoria,
           subrubro        = EXCLUDED.subrubro,
           precio          = EXCLUDED.precio,
           origen          = COALESCE(maxi_articles.origen, 'onboarding'),
           upload_batch_id = EXCLUDED.upload_batch_id,
           updated_at      = NOW()`,
        [storageBizId, newId, it.nombre, maxiCategoria, maxiSubrubro, it.precio, batchId]
      );

      inserted++;
    }

    await client.query('COMMIT');
    invalidateCacheForBiz(bizId);
    if (storageBizId !== bizId) invalidateCacheForBiz(storageBizId);

    console.log(`✅ [onboarding/articulos-bulk] biz=${bizId} storage=${storageBizId} batch=${batchId} insertados=${inserted}`);

    return res.json({
      ok: true, inserted, total: items.length,
      batchId, target_business_id: storageBizId,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[onboarding/articulos-bulk]', e.message);
    next(e);
  } finally {
    client.release();
  }
};