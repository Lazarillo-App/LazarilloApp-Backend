// services/csvArticulosImportService.js
'use strict';

/**
 * Importación CSV de artículos desde MaxiRest.
 *
 * MaxiRest exporta artículos desde: Artículos → Excel (el listado general)
 * Columnas esperadas (case-insensitive):
 *   COD_RU | CODIGO | NOMBRE | UNIDAD_MED | PRECIO | ULT_COMPRA (opcional)
 *
 * Estrategia:
 *   - Upsert en maxi_articles por (business_id, articulo_id) — igual que la sync de API
 *   - Si el artículo ya existe → actualiza nombre, categoria, precio
 *   - Si no existe → lo crea
 *   - NUNCA borra — solo agrega/actualiza
 *   - Resuelve siempre al negocio principal de la organización
 *
 * IMPORTANTE: maxi_articles usa "categoria" y "subrubro" como texto libre.
 * El CSV tiene COD_RU (código numérico de rubro) — lo guardamos como categoria.
 * Cuando la sync normal corra después, va a pisar con los valores correctos.
 */

const pool = require('../config/db');
const XLSX = require('xlsx');
const fs   = require('fs');

// ── helpers ──────────────────────────────────────────────────────────────────

function getCI(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  const map = new Map();
  for (const k of Object.keys(obj)) map.set(String(k).trim().toLowerCase(), k);
  for (const candidate of keys) {
    const real = map.get(String(candidate).trim().toLowerCase());
    if (real != null) return obj[real];
  }
  return undefined;
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// ── parseo del archivo ────────────────────────────────────────────────────────

async function parseFile(filePath) {
  const workbook = XLSX.readFile(filePath, { type: 'file', raw: true, cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('El archivo no contiene hojas');

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    raw: true, defval: null,
  });

  const cleaned = rows
    .map(row => {
      const out = {};
      for (const k of Object.keys(row)) {
        const kl = String(k).toLowerCase().trim();
        if (kl.startsWith('__empty')) continue;
        out[k] = row[k];
      }
      return out;
    })
    .filter(r => Object.values(r).some(v => v != null && v !== ''));

  if (!cleaned.length) throw new Error('El archivo no contiene filas de datos');

  // Validar columnas mínimas
  const headersLower = Object.keys(cleaned[0] || {}).map(h => h.toLowerCase().trim());
  const missing = ['codigo', 'nombre'].filter(r => !headersLower.includes(r));
  if (missing.length) {
    throw new Error(
      `Columnas faltantes: ${missing.join(', ')}. ` +
      `El archivo debe tener al menos: CODIGO y NOMBRE. ` +
      `Columnas encontradas: ${headersLower.join(', ')}`
    );
  }

  return cleaned;
}

function normalizeRow(row, idx) {
  try {
    // CODIGO → articulo_id (PK en maxi_articles)
    const codigoRaw = String(getCI(row, ['codigo', 'code', 'cod', 'id']) ?? '').trim();
    const articulo_id = parseInt(codigoRaw, 10);
    if (!codigoRaw || !Number.isFinite(articulo_id) || articulo_id <= 0) {
      throw new Error(`Código inválido: "${codigoRaw}"`);
    }

    const nombre = String(getCI(row, ['nombre', 'name', 'descripcion', 'descripción']) ?? '').trim();
    if (!nombre) throw new Error(`Nombre vacío en código ${articulo_id}`);

    // COD_RU → categoría como texto (lo que tiene la sync de Maxi)
    const codRu     = getCI(row, ['cod_ru', 'rubro', 'categoria', 'categoría', 'cat', 'cod_rub']);
    const categoria = codRu != null && String(codRu).trim() !== ''
      ? String(codRu).trim()
      : 'Sin categoría';

    const precio      = parseNum(getCI(row, ['precio', 'price', 'precio_ref', 'p_ref'])) ?? 0;
    const unidad_med  = String(getCI(row, ['unidad_med', 'unidad', 'medida', 'unit', 'u.med']) ?? '').trim() || null;

    return {
      ok: true,
      data: { articulo_id, nombre, categoria, precio, unidad_med },
    };
  } catch (e) {
    return { ok: false, error: e.message, row: idx + 1 };
  }
}

// ── función principal ─────────────────────────────────────────────────────────

async function importArticulosFromFile({ businessId, filePath, originalName }) {
  const client = await pool.connect();
  let txOpen = false;

  try {
    // Resolver siempre al negocio principal
    const { rows: bizRows } = await pool.query(
      `SELECT created_from, organization_id FROM app_businesses WHERE id = $1`, [businessId]
    );
    const biz = bizRows[0] || {};
    let targetBizId = Number(businessId);
    if (biz.created_from === 'from_group' && biz.organization_id) {
      const { rows: rootRows } = await pool.query(
        `SELECT id FROM app_businesses
          WHERE organization_id = $1
            AND (created_from IS NULL OR created_from = 'manual' OR created_from = 'onboarding')
          ORDER BY id ASC LIMIT 1`,
        [biz.organization_id]
      );
      if (rootRows[0]?.id) targetBizId = Number(rootRows[0].id);
    }

    const rawRows = await parseFile(filePath);

    // Normalizar
    const errors = [];
    const items  = [];
    for (let i = 0; i < rawRows.length; i++) {
      const norm = normalizeRow(rawRows[i], i);
      if (!norm.ok) errors.push({ row: i + 1, error: norm.error });
      else items.push(norm.data);
    }

    if (!items.length) {
      try { fs.unlinkSync(filePath); } catch { }
      return {
        ok: false, error: 'no_valid_rows',
        summary: { total_rows: rawRows.length, inserted: 0, updated: 0, failed: errors.length },
        errors: errors.slice(0, 20),
      };
    }

    await client.query('BEGIN');
    txOpen = true;

    let inserted = 0, updated = 0;
    const CHUNK = 200;

    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);

      // Build bulk upsert
      const values = [];
      const params = [];
      let p = 1;

      for (const it of chunk) {
        values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},'{}'::jsonb,NOW())`);
        params.push(
          targetBizId,
          it.articulo_id,
          it.nombre,
          it.categoria,
          'Sin subrubro',   // subrubro: lo actualiza la sync cuando corra
          it.precio,
        );
        p += 6;
      }

      const res = await client.query(
        `INSERT INTO maxi_articles
           (business_id, articulo_id, nombre, categoria, subrubro, precio, raw, updated_at)
         VALUES ${values.join(',')}
         ON CONFLICT (business_id, articulo_id) DO UPDATE SET
           nombre     = EXCLUDED.nombre,
           categoria  = EXCLUDED.categoria,
           precio     = EXCLUDED.precio,
           updated_at = NOW()
         RETURNING (xmax = 0) AS is_insert`,
        params
      );

      for (const row of res.rows) {
        if (row.is_insert) inserted++; else updated++;
      }
    }

    await client.query('COMMIT');
    txOpen = false;

    try { fs.unlinkSync(filePath); } catch { }

    return {
      ok: true,
      summary: {
        total_rows: rawRows.length,
        inserted,
        updated,
        failed:     errors.length,
        has_errors: errors.length > 0,
        target_business_id: targetBizId,
      },
      errors: errors.slice(0, 20),
    };

  } catch (error) {
    if (txOpen) { try { await client.query('ROLLBACK'); } catch { } }
    console.error('[CSV Articulos Import] Error fatal:', error);
    try { fs.unlinkSync(filePath); } catch { }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { importArticulosFromFile };