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

// ── crear tabla FUERA de transacción ──────────────────────────────────────
// Usar una conexión separada sin transacción para el DDL
async function ensureTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS articulo_rubros (
        id          SERIAL PRIMARY KEY,
        business_id BIGINT  NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
        codigo      INTEGER NOT NULL,
        nombre      TEXT    NOT NULL,
        codigo_sua  INTEGER,
        subrubro    TEXT,
        activo      BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (business_id, codigo)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_art_rubros_biz ON articulo_rubros(business_id)
    `);
    console.log('[csvArticulosRubrosImport] Tabla articulo_rubros verificada OK');
  } catch (e) {
    console.error('[csvArticulosRubrosImport] Error al crear tabla:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// ── función principal ──────────────────────────────────────────────────────

async function importRubrosArticulosFromFile({ businessId, filePath, originalName, mapeo = {} }) {
  // 1. Crear tabla ANTES de cualquier transacción
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
  console.log(`[csvArticulosRubrosImport] bizId=${businessId} → targetBizId=${targetBizId}`);

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

  // Detectar columnas de mapeo del front
  const colCodigo = mapeo ? Object.keys(mapeo).find(k => mapeo[k] === 'codigo') : null;
  const colNombre = mapeo ? Object.keys(mapeo).find(k => mapeo[k] === 'nombre') : null;
  console.log(`[csvArticulosRubrosImport] mapeo: colCodigo="${colCodigo}" colNombre="${colNombre}"`);

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

      const codigoSua = safeInt(getCI(row, ['cod_sua', 'codsua', 'codigo_sua', 'sub_id']));
      const subrubro  = cleanStr(getCI(row, ['nombre_sua', 'subrubro', 'subcategoria', 'desc_sua']));

      const { rows: res } = await client.query(
        `INSERT INTO articulo_rubros (business_id, codigo, nombre, codigo_sua, subrubro, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (business_id, codigo) DO UPDATE SET
           nombre     = EXCLUDED.nombre,
           codigo_sua = COALESCE(EXCLUDED.codigo_sua, articulo_rubros.codigo_sua),
           subrubro   = COALESCE(EXCLUDED.subrubro,   articulo_rubros.subrubro),
           activo     = TRUE,
           updated_at = NOW()
         RETURNING (xmax = 0) AS is_insert`,
        [targetBizId, codigo, nombre, codigoSua, subrubro]
      );

      if (res[0]?.is_insert) inserted++; else updated++;
    }

    await client.query('COMMIT');
    txOpen = false;
    console.log(`[csvArticulosRubrosImport] Rubros: inserted=${inserted} updated=${updated} skipped=${skipped}`);

  } catch (error) {
    if (txOpen) { try { await client.query('ROLLBACK'); } catch { } }
    client.release();
    try { fs.unlinkSync(filePath); } catch { }
    console.error('[csvArticulosRubrosImport] Error en transacción:', error.message);
    throw error;
  }
  client.release();

  // 5. Cruce con maxi_articles — conexión separada, sin transacción
  // Si falla, no es crítico — los rubros ya están guardados
  let articulosActualizados = 0;
  const crossClient = await pool.connect();
  try {
    const { rowCount: rc1 } = await crossClient.query(
      `UPDATE maxi_articles ma
          SET categoria  = ar.nombre,
              updated_at = NOW()
         FROM articulo_rubros ar
        WHERE ar.business_id = $1
          AND ma.business_id = $1
          AND ma.categoria ~ '^[0-9]+$'
          AND ar.codigo::text = ma.categoria`,
      [targetBizId]
    );
    console.log(`[csvArticulosRubrosImport] Cruce categoria: ${rc1} artículos actualizados`);
    articulosActualizados += (rc1 || 0);
  } catch (e) {
    console.warn('[csvArticulosRubrosImport] Cruce categoria falló:', e.message);
  } finally {
    crossClient.release();
  }

  try { fs.unlinkSync(filePath); } catch { }

  return {
    ok: true,
    summary: {
      total: inserted + updated + skipped,
      inserted,
      updated,
      skipped,
      target_business_id: targetBizId,
    },
    articulosActualizados,
    message: `${inserted} rubros nuevos, ${updated} actualizados. ${articulosActualizados} artículos actualizados con nombre de categoría.`,
  };
}

module.exports = { importRubrosArticulosFromFile };