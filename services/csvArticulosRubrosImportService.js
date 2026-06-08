// services/csvArticulosRubrosImportService.js
'use strict';

const pool = require('../config/db');
const XLSX = require('xlsx');
const fs   = require('fs');

// ── helpers ────────────────────────────────────────────────────────────────

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
  return String(v).trim().replace(/\s+/g, ' ') || null;
}

function safeInt(v) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ── parseo ─────────────────────────────────────────────────────────────────

async function parseFile(filePath) {
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

// ── crear/actualizar tabla ────────────────────────────────────────────────

async function ensureTable() {
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
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_art_rubros_biz ON articulo_rubros(business_id)
    `);
    // Agregar columnas si no existen (para DBs ya existentes)
    await client.query(`
      ALTER TABLE articulo_rubros ADD COLUMN IF NOT EXISTS destino TEXT NOT NULL DEFAULT 'categoria'
    `).catch(() => {});
    await client.query(`
      ALTER TABLE articulo_rubros ADD COLUMN IF NOT EXISTS upload_batch_id TEXT
    `).catch(() => {});
    console.log('[csvArticulosRubrosImport] Tabla articulo_rubros verificada OK');
  } catch (e) {
    console.error('[csvArticulosRubrosImport] Error al crear tabla:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// ── función principal ──────────────────────────────────────────────────────

/**
 * destino: 'categoria' | 'subrubro'
 *   'categoria' → actualiza maxi_articles.categoria con los nombres
 *   'subrubro'  → actualiza maxi_articles.subrubro con los nombres
 */
async function importRubrosArticulosFromFile({
  businessId, filePath, originalName, mapeo = {}, destino = 'categoria'
}) {
  // 1. Crear tabla antes de cualquier transacción
  await ensureTable();

  // 2. Resolver negocio principal
  const { rows: [biz] } = await pool.query(
    `SELECT created_from, organization_id FROM app_businesses WHERE id = $1`, [businessId]
  );
  let targetBizId = Number(businessId);
  if (biz?.created_from === 'from_group' && biz.organization_id) {
    const { rows: [root] } = await pool.query(
      `SELECT id FROM app_businesses
        WHERE organization_id = $1
          AND (created_from IS NULL OR created_from = 'manual' OR created_from = 'onboarding')
        ORDER BY id ASC LIMIT 1`,
      [biz.organization_id]
    );
    if (root?.id) targetBizId = Number(root.id);
  }
  console.log(`[csvArticulosRubrosImport] bizId=${businessId} → targetBizId=${targetBizId} destino=${destino}`);

  // 3. Parsear archivo
  let rawRows;
  try {
    rawRows = await parseFile(filePath);
  } catch (e) {
    try { fs.unlinkSync(filePath); } catch { }
    throw new Error(`Error al leer el archivo: ${e.message}`);
  }

  console.log(`[csvArticulosRubrosImport] Filas leídas: ${rawRows.length}`);
  if (!rawRows.length) {
    try { fs.unlinkSync(filePath); } catch { }
    return { ok: true, summary: { total: 0, inserted: 0, updated: 0, skipped: 0 }, articulosActualizados: 0 };
  }

  const colCodigo = mapeo ? Object.keys(mapeo).find(k => mapeo[k] === 'codigo') : null;
  const colNombre = mapeo ? Object.keys(mapeo).find(k => mapeo[k] === 'nombre') : null;
  const batchId   = `rubros-${destino}-${Date.now()}`;

  // 4. Transacción para insertar rubros
  const client = await pool.connect();
  let txOpen = false;
  let inserted = 0, updated = 0, skipped = 0;

  try {
    await client.query('BEGIN');
    txOpen = true;

    for (const row of rawRows) {
      const codRuaRaw = (colCodigo && row[colCodigo] != null)
        ? row[colCodigo]
        : getCI(row, ['cod_rua', 'codrua', 'cod_ru', 'codigo', 'code', 'id', 'cod']);

      const codigo = safeInt(codRuaRaw);
      if (codigo == null) { skipped++; continue; }

      const nombreRaw = (colNombre && row[colNombre] != null)
        ? row[colNombre]
        : getCI(row, ['nombre', 'name', 'descripcion', 'descripción', 'denominacion']);
      const nombre = cleanStr(nombreRaw);
      if (!nombre) { skipped++; continue; }

      const { rows: res } = await client.query(
        `INSERT INTO articulo_rubros
           (business_id, codigo, nombre, destino, upload_batch_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (business_id, codigo, destino) DO UPDATE SET
           nombre          = EXCLUDED.nombre,
           upload_batch_id = EXCLUDED.upload_batch_id,
           activo          = TRUE,
           updated_at      = NOW()
         RETURNING (xmax = 0) AS is_insert`,
        [targetBizId, codigo, nombre, destino, batchId]
      );

      if (res[0]?.is_insert) inserted++; else updated++;
    }

    await client.query('COMMIT');
    txOpen = false;
    console.log(`[csvArticulosRubrosImport] inserted=${inserted} updated=${updated} skipped=${skipped}`);

  } catch (error) {
    if (txOpen) { try { await client.query('ROLLBACK'); } catch { } }
    client.release();
    try { fs.unlinkSync(filePath); } catch { }
    throw error;
  }
  client.release();

  // 5. Cruce con maxi_articles según destino
  let articulosActualizados = 0;
  const crossClient = await pool.connect();
  try {
    // La columna a actualizar depende del destino
    const colDestino = destino === 'subrubro' ? 'subrubro' : 'categoria';

    const { rowCount } = await crossClient.query(
      `UPDATE maxi_articles ma
          SET ${colDestino} = ar.nombre,
              updated_at    = NOW()
         FROM articulo_rubros ar
        WHERE ar.business_id = $1
          AND ma.business_id = $1
          AND ar.destino     = $2
          AND ma.${colDestino} ~ '^[0-9]+$'
          AND ar.codigo::text = ma.${colDestino}`,
      [targetBizId, destino]
    );
    articulosActualizados = rowCount || 0;
    console.log(`[csvArticulosRubrosImport] Cruce ${colDestino}: ${articulosActualizados} artículos actualizados`);
  } catch (e) {
    console.warn('[csvArticulosRubrosImport] Cruce falló:', e.message);
  } finally {
    crossClient.release();
  }

  try { fs.unlinkSync(filePath); } catch { }

  return {
    ok: true,
    batchId,
    summary: { total: inserted + updated + skipped, inserted, updated, skipped, target_business_id: targetBizId },
    articulosActualizados,
    destino,
    message: `${inserted} rubros nuevos, ${updated} actualizados → ${articulosActualizados} artículos con ${destino === 'subrubro' ? 'subrubro' : 'categoría'} actualizado.`,
  };
}

// ── listar lotes de rubros ────────────────────────────────────────────────

async function listBatchesRubros(bizId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(upload_batch_id, 'rubros-sin-lote') AS batch_id,
       MIN(updated_at)                              AS created_at,
       COUNT(*)::int                                AS total_items,
       destino                                      AS origenes
     FROM articulo_rubros
     WHERE business_id = $1
     GROUP BY COALESCE(upload_batch_id, 'rubros-sin-lote'), destino
     ORDER BY MIN(updated_at) DESC`,
    [bizId]
  );
  return rows;
}

async function previewBatchRubros(bizId, batchId) {
  const isSinLote = batchId === 'rubros-sin-lote';
  const { rows } = await pool.query(
    isSinLote
      ? `SELECT id, codigo, nombre, destino, updated_at FROM articulo_rubros
          WHERE business_id = $1 AND upload_batch_id IS NULL
          ORDER BY nombre ASC LIMIT 200`
      : `SELECT id, codigo, nombre, destino, updated_at FROM articulo_rubros
          WHERE business_id = $1 AND upload_batch_id = $2
          ORDER BY nombre ASC LIMIT 200`,
    isSinLote ? [bizId] : [bizId, batchId]
  );
  return rows;
}

async function deleteBatchRubros(bizId, batchId) {
  const isSinLote = batchId === 'rubros-sin-lote';
  const { rowCount } = await pool.query(
    isSinLote
      ? `DELETE FROM articulo_rubros WHERE business_id = $1 AND upload_batch_id IS NULL`
      : `DELETE FROM articulo_rubros WHERE business_id = $1 AND upload_batch_id = $2`,
    isSinLote ? [bizId] : [bizId, batchId]
  );
  return rowCount;
}

module.exports = {
  importRubrosArticulosFromFile,
  listBatchesRubros,
  previewBatchRubros,
  deleteBatchRubros,
};