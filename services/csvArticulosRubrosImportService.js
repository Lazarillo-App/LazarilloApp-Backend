// services/csvArticulosRubrosImportService.js
'use strict';

/**
 * Importación de rubros de artículos desde CSV, XLS o XLSX.
 *
 * Tabla destino: articulo_rubros
 *   Creada automáticamente si no existe.
 *   Misma estructura que insumo_rubros pero para artículos.
 *
 * El archivo típico tiene (ej: "listado_rubros_articulos.xls"):
 *   COD_RUA  → codigo del rubro (ej: 1)
 *   NOMBRE   → nombre del rubro (ej: "Gaseosas")
 *   COD_SUA  → código de subrubro (opcional, ej: 13)
 *   NOMBRE_SUA → nombre del subrubro (opcional)
 *
 * Después de importar, cruza con maxi_articles para reemplazar
 * los códigos numéricos en `categoria` y `subrubro` por nombres reales.
 */

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

// ── asegurar que la tabla existe ───────────────────────────────────────────

async function ensureTable(client) {
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
}

// ── función principal ──────────────────────────────────────────────────────

async function importRubrosArticulosFromFile({ businessId, filePath, originalName }) {
  const client  = await pool.connect();
  let txOpen    = false;

  try {
    // Resolver al negocio principal
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

    const rawRows = await parseFile(filePath);
    if (!rawRows.length) {
      try { fs.unlinkSync(filePath); } catch { }
      return { ok: true, summary: { total: 0, inserted: 0, updated: 0, skipped: 0 }, articulosActualizados: 0 };
    }

    await client.query('BEGIN');
    txOpen = true;
    await ensureTable(client);

    let inserted = 0, updated = 0, skipped = 0;

    for (const row of rawRows) {
      // Código del rubro: COD_RUA > codigo > id
      const codRuaRaw = getCI(row, ['cod_rua', 'codrua', 'cod_ru', 'codigo', 'code', 'id', 'cod']);
      const codigo    = safeInt(codRuaRaw);
      if (codigo == null) { skipped++; continue; }

      const nombre = cleanStr(getCI(row, ['nombre', 'name', 'descripcion', 'descripción', 'denominacion', 'categoria', 'rubro']));
      if (!nombre) { skipped++; continue; }

      // Subrubro (COD_SUA + nombre)
      const codigoSua = safeInt(getCI(row, ['cod_sua', 'codsua', 'codigo_sua', 'sub_id']));
      const subrubro  = cleanStr(getCI(row, ['nombre_sua', 'subrubro', 'subcategoria', 'desc_sua', 'nombre_subrubro']));

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

    // ── Cruzar con maxi_articles: reemplazar códigos numéricos por nombres ──
    let articulosActualizados = 0;
    try {
      // Actualizar categoria donde está guardado como número (COD_RUA)
      const { rowCount: rc1 } = await client.query(
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

      // Actualizar subrubro donde está guardado como número (COD_SUA) y tenemos nombre
      const { rowCount: rc2 } = await client.query(
        `UPDATE maxi_articles ma
            SET subrubro   = ar.subrubro,
                updated_at = NOW()
           FROM articulo_rubros ar
          WHERE ar.business_id = $1
            AND ma.business_id = $1
            AND ar.subrubro IS NOT NULL
            AND ma.subrubro ~ '^[0-9]+$'
            AND ar.codigo_sua::text = ma.subrubro`,
        [targetBizId]
      );

      articulosActualizados = (rc1 || 0) + (rc2 || 0);
    } catch (crossErr) {
      console.warn('[importRubrosArticulos] cruce con artículos falló (no crítico):', crossErr.message);
    }

    await client.query('COMMIT');
    txOpen = false;

    try { fs.unlinkSync(filePath); } catch { }

    console.log(`[csvArticulosRubrosImport] biz=${targetBizId} inserted=${inserted} updated=${updated} arts=${articulosActualizados}`);

    return {
      ok: true,
      summary: {
        total:    inserted + updated + skipped,
        inserted,
        updated,
        skipped,
        target_business_id: targetBizId,
      },
      articulosActualizados,
      message: `${inserted} rubros nuevos, ${updated} actualizados. ${articulosActualizados} artículos cruzados con nombres de categoría.`,
    };

  } catch (error) {
    if (txOpen) { try { await client.query('ROLLBACK'); } catch { } }
    console.error('[CSV Articulos Rubros Import] Error fatal:', error.message);
    try { fs.unlinkSync(filePath); } catch { }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { importRubrosArticulosFromFile };