// services/csvArticulosImportPairedService.js
// Importación combinada: rubros + subrubros + artículos en una sola operación.
// Hace el cruce automático COD_RUA / COD_SUA → nombre de rubro / subrubro.
//
// La sync con MaxiRest es estrictamente aditiva (ON CONFLICT DO NOTHING).
// Esta importación manual SÍ pisa nombres/categorías porque viene de un upload
// explícito del usuario — es la forma de corregir datos.
'use strict';

const pool = require('../config/db');
const XLSX = require('xlsx');
const fs = require('fs');

// ── Helpers ──────────────────────────────────────────────────────────────

function getCI(obj, candidates) {
  if (!obj || typeof obj !== 'object') return undefined;
  const map = new Map();
  for (const k of Object.keys(obj)) map.set(String(k).trim().toLowerCase(), k);
  for (const c of candidates) {
    const real = map.get(String(c).trim().toLowerCase());
    if (real != null && obj[real] != null && obj[real] !== '') return obj[real];
  }
  return undefined;
}

function cleanStr(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  return s || null;
}

function safeInt(v) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseFile(filePath) {
  const wb = XLSX.readFile(filePath, { type: 'file', raw: true, cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('El archivo no contiene hojas');
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { raw: true, defval: null });
  return rows
    .map(row => {
      const out = {};
      for (const k of Object.keys(row)) {
        if (String(k).toLowerCase().trim().startsWith('__empty')) continue;
        out[k] = row[k];
      }
      return out;
    })
    .filter(r => Object.values(r).some(v => v != null && v !== ''));
}

async function ensureRubrosTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS articulo_rubros (
        id              SERIAL PRIMARY KEY,
        business_id     BIGINT  NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
        codigo          INTEGER NOT NULL,
        nombre          TEXT    NOT NULL,
        codigo_sua      INTEGER,
        subrubro        TEXT,
        destino         TEXT    NOT NULL DEFAULT 'categoria',
        upload_batch_id TEXT,
        activo          BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (business_id, codigo, destino)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_art_rubros_biz ON articulo_rubros(business_id)`);
    await client.query(`ALTER TABLE articulo_rubros ADD COLUMN IF NOT EXISTS destino TEXT NOT NULL DEFAULT 'categoria'`).catch(() => {});
    await client.query(`ALTER TABLE articulo_rubros ADD COLUMN IF NOT EXISTS upload_batch_id TEXT`).catch(() => {});
  } finally {
    client.release();
  }
}

async function resolveTargetBizId(businessId) {
  const { rows: [biz] } = await pool.query(
    `SELECT created_from, organization_id FROM app_businesses WHERE id = $1`,
    [businessId]
  );
  if (biz?.created_from === 'from_group' && biz.organization_id) {
    const { rows: [root] } = await pool.query(
      `SELECT id FROM app_businesses
        WHERE organization_id = $1
          AND (created_from IS NULL OR created_from = 'manual' OR created_from = 'onboarding')
        ORDER BY id ASC LIMIT 1`,
      [biz.organization_id]
    );
    if (root?.id) return Number(root.id);
  }
  return Number(businessId);
}

// ── Lectura de archivos a estructuras intermedias ─────────────────────────

function parseRubrosFile(filePath) {
  const rows = parseFile(filePath);
  const out = new Map(); // codigo → nombre
  for (const row of rows) {
    const cod = safeInt(getCI(row, ['codigo', 'cod_rua', 'codrua', 'code', 'id', 'cod']));
    const nombre = cleanStr(getCI(row, ['nombre', 'name', 'descripcion', 'descripción']));
    if (cod == null || !nombre) continue;
    out.set(cod, nombre);
  }
  return out;
}

function parseSubrubrosFile(filePath) {
  const rows = parseFile(filePath);
  const out = new Map(); // codigo (COD_SUA) → { nombre, rubroCodigo }
  for (const row of rows) {
    const cod = safeInt(getCI(row, ['codigo', 'cod_sua', 'codsua', 'code', 'id']));
    const nombre = cleanStr(getCI(row, ['nombre', 'name', 'descripcion', 'descripción']));
    const rubroCod = safeInt(getCI(row, ['cod_rua', 'codrua', 'cod_ru', 'rubro', 'rubro_codigo']));
    if (cod == null || !nombre) continue;
    out.set(cod, { nombre, rubroCodigo: rubroCod });
  }
  return out;
}

function parseArticulosFile(filePath) {
  const rows = parseFile(filePath);
  const out = [];
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cod = safeInt(getCI(row, ['codigo', 'cod_rua', 'codrua', 'cod_ru', 'articulo_id', 'art_id', 'code', 'id']));
    const nombre = cleanStr(getCI(row, ['nombre', 'name', 'descripcion', 'descripción', 'denominacion']));
    if (cod == null) { errors.push({ row: i + 2, error: 'Sin código' }); continue; }
    if (!nombre) { errors.push({ row: i + 2, error: `Sin nombre (cod ${cod})` }); continue; }

    const codRubro = safeInt(getCI(row, ['cod_rua', 'codrua', 'cod_ru', 'rubro_codigo', 'cod_rubro']));
    const codSubrubro = safeInt(getCI(row, ['cod_sua', 'codsua', 'subrubro_codigo', 'cod_subrubro']));
    const precio = parseNum(getCI(row, ['precio1', 'precio', 'price', 'precio_venta', 'precio_ref', 'p_ref', 'precio2'])) ?? 0;

    out.push({
      articulo_id: cod,
      nombre,
      cod_rubro: codRubro,
      cod_subrubro: codSubrubro,
      precio,
    });
  }
  return { items: out, errors };
}

// ── Función principal ─────────────────────────────────────────────────────

/**
 * Importa rubros + subrubros + artículos en una sola operación con cruce automático.
 *
 * @param {Object} params
 * @param {number} params.businessId
 * @param {string|null} params.rubrosFilePath  - archivo de rubros (opcional)
 * @param {string|null} params.subrubrosFilePath - archivo de subrubros (opcional)
 * @param {string} params.articulosFilePath - archivo de artículos (requerido)
 */
async function importPaired({ businessId, rubrosFilePath, subrubrosFilePath, articulosFilePath }) {
  if (!articulosFilePath) {
    throw new Error('El archivo de artículos es requerido');
  }

  await ensureRubrosTable();
  const targetBizId = await resolveTargetBizId(businessId);
  const batchId = `paired-art-${Date.now()}`;

  // ── 1. Parsear archivos ────────────────────────────────────────────────
  let rubrosMap = new Map();
  let subrubrosMap = new Map();
  let articulosData = { items: [], errors: [] };

  try {
    if (rubrosFilePath) rubrosMap = parseRubrosFile(rubrosFilePath);
    if (subrubrosFilePath) subrubrosMap = parseSubrubrosFile(subrubrosFilePath);
    articulosData = parseArticulosFile(articulosFilePath);
  } catch (e) {
    // Limpiar archivos antes de propagar
    [rubrosFilePath, subrubrosFilePath, articulosFilePath].forEach(p => {
      if (p) try { fs.unlinkSync(p); } catch {}
    });
    throw new Error(`Error al leer archivo: ${e.message}`);
  }

  const client = await pool.connect();
  let txOpen = false;

  try {
    await client.query('BEGIN');
    txOpen = true;

    // ── 2. Upsert de rubros en articulo_rubros ──────────────────────────
    let rubrosInserted = 0, rubrosUpdated = 0;
    for (const [codigo, nombre] of rubrosMap.entries()) {
      const res = await client.query(
        `INSERT INTO articulo_rubros
           (business_id, codigo, nombre, destino, upload_batch_id, updated_at)
         VALUES ($1, $2, $3, 'categoria', $4, NOW())
         ON CONFLICT (business_id, codigo, destino) DO UPDATE SET
           nombre = EXCLUDED.nombre,
           upload_batch_id = EXCLUDED.upload_batch_id,
           activo = TRUE,
           updated_at = NOW()
         RETURNING (xmax = 0) AS is_insert`,
        [targetBizId, codigo, nombre, batchId]
      );
      if (res.rows[0]?.is_insert) rubrosInserted++; else rubrosUpdated++;
    }

    // ── 3. Upsert de subrubros en articulo_rubros (destino=subrubro) ────
    let subrubrosInserted = 0, subrubrosUpdated = 0;
    for (const [codigo, info] of subrubrosMap.entries()) {
      const res = await client.query(
        `INSERT INTO articulo_rubros
           (business_id, codigo, nombre, destino, upload_batch_id, updated_at)
         VALUES ($1, $2, $3, 'subrubro', $4, NOW())
         ON CONFLICT (business_id, codigo, destino) DO UPDATE SET
           nombre = EXCLUDED.nombre,
           upload_batch_id = EXCLUDED.upload_batch_id,
           activo = TRUE,
           updated_at = NOW()
         RETURNING (xmax = 0) AS is_insert`,
        [targetBizId, codigo, info.nombre, batchId]
      );
      if (res.rows[0]?.is_insert) subrubrosInserted++; else subrubrosUpdated++;
    }

    // ── 4. Upsert de artículos con CRUCE automático ──────────────────────
    // categoria ← nombre del rubro (resolviendo cod_rubro vía rubrosMap)
    // subrubro  ← nombre del subrubro (resolviendo cod_subrubro vía subrubrosMap)
    // Si no hay archivo de rubros/subrubros, usamos lo que ya esté en articulo_rubros
    // (cargado en una pasada anterior).
    let artInserted = 0, artUpdated = 0;
    const CHUNK = 200;

    // Cargar lo existente en articulo_rubros para usar de fallback
    const { rows: rubrosExist } = await client.query(
      `SELECT codigo, nombre, destino FROM articulo_rubros
        WHERE business_id = $1 AND activo = TRUE`,
      [targetBizId]
    );
    const rubroNombreByCod = new Map();
    const subrubroNombreByCod = new Map();
    for (const r of rubrosExist) {
      if (r.destino === 'categoria') rubroNombreByCod.set(Number(r.codigo), r.nombre);
      if (r.destino === 'subrubro') subrubroNombreByCod.set(Number(r.codigo), r.nombre);
    }
    // Pisar con lo que vino en este upload (más fresco)
    for (const [cod, nombre] of rubrosMap.entries()) rubroNombreByCod.set(cod, nombre);
    for (const [cod, info] of subrubrosMap.entries()) subrubroNombreByCod.set(cod, info.nombre);

    for (let i = 0; i < articulosData.items.length; i += CHUNK) {
      const chunk = articulosData.items.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      let p = 1;

      for (const it of chunk) {
        const rubroNombre = it.cod_rubro != null
          ? rubroNombreByCod.get(it.cod_rubro) || `Rubro ${it.cod_rubro}`
          : 'Sin categoría';
        const subrubroNombre = it.cod_subrubro != null
          ? subrubroNombreByCod.get(it.cod_subrubro) || null
          : null;

        values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},'{}'::jsonb,NOW(),$${p+6},'csv')`);
        params.push(targetBizId, it.articulo_id, it.nombre, rubroNombre, subrubroNombre, it.precio, batchId);
        p += 7;
      }

      const res = await client.query(
        `INSERT INTO maxi_articles
           (business_id, articulo_id, nombre, categoria, subrubro, precio, raw, updated_at, upload_batch_id, origen)
         VALUES ${values.join(',')}
         ON CONFLICT (business_id, articulo_id) DO UPDATE SET
           nombre          = EXCLUDED.nombre,
           categoria       = EXCLUDED.categoria,
           subrubro        = COALESCE(EXCLUDED.subrubro, maxi_articles.subrubro),
           precio          = EXCLUDED.precio,
           upload_batch_id = EXCLUDED.upload_batch_id,
           origen          = COALESCE(maxi_articles.origen, EXCLUDED.origen),
           updated_at      = NOW()
         RETURNING (xmax = 0) AS is_insert`,
        params
      );

      for (const row of res.rows) {
        if (row.is_insert) artInserted++; else artUpdated++;
      }
    }

    await client.query('COMMIT');
    txOpen = false;

    console.log(
      `[importPaired] biz=${targetBizId} batch=${batchId} ` +
      `rubros=${rubrosInserted}+${rubrosUpdated} ` +
      `subrubros=${subrubrosInserted}+${subrubrosUpdated} ` +
      `articulos=${artInserted}+${artUpdated} errors=${articulosData.errors.length}`
    );

    return {
      ok: true,
      batchId,
      target_business_id: targetBizId,
      rubros: { inserted: rubrosInserted, updated: rubrosUpdated, total: rubrosMap.size },
      subrubros: { inserted: subrubrosInserted, updated: subrubrosUpdated, total: subrubrosMap.size },
      articulos: {
        inserted: artInserted,
        updated: artUpdated,
        failed: articulosData.errors.length,
        total: articulosData.items.length + articulosData.errors.length,
      },
      summary: {
        // Para mantener compat con UI que lee summary.inserted/updated
        inserted: artInserted,
        updated: artUpdated,
        failed: articulosData.errors.length,
        total: articulosData.items.length + articulosData.errors.length,
      },
      errors: articulosData.errors.slice(0, 20),
    };

  } catch (e) {
    if (txOpen) { try { await client.query('ROLLBACK'); } catch {} }
    throw e;
  } finally {
    client.release();
    // Limpiar archivos temporales
    [rubrosFilePath, subrubrosFilePath, articulosFilePath].forEach(p => {
      if (p) try { fs.unlinkSync(p); } catch {}
    });
  }
}

module.exports = { importPaired };