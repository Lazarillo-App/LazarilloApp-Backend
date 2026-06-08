// services/csvArticulosImportService.js
'use strict';

/**
 * Importación de artículos desde CSV, XLS o XLSX.
 *
 * Columnas reconocidas (case-insensitive, orden de preferencia):
 *   articulo_id : CODIGO, COD_RUA, cod_ru, codigo, code, id
 *   nombre      : NOMBRE, nombre, name, descripcion
 *   categoria   : COD_RUA (si no hay nombre de cat), rubro, categoria, cat
 *   subrubro    : COD_SUA, subrubro, subcategoria
 *   precio      : PRECIO1, precio1, PRECIO, precio, price
 *
 * Estrategia de upsert:
 *   - Usa CODIGO como articulo_id (PK en maxi_articles)
 *   - Si ya existe → actualiza nombre, categoria, precio, upload_batch_id
 *   - Si no existe → inserta
 *   - NUNCA borra registros existentes
 *   - categoria: si viene de sincronización previa con nombre real, NO la pisa con un número
 *   - Resuelve siempre al negocio principal de la organización
 */

const pool = require('../config/db');
const XLSX = require('xlsx');
const fs   = require('fs');

// ── detección de columnas case-insensitive ─────────────────────────────────

/**
 * Busca una clave en un objeto de forma case-insensitive.
 * Acepta lista de candidatos en orden de prioridad.
 */
function getCI(obj, candidates) {
  if (!obj || typeof obj !== 'object') return undefined;
  const map = new Map();
  for (const k of Object.keys(obj)) {
    map.set(String(k).trim().toLowerCase(), k);
  }
  for (const c of candidates) {
    const real = map.get(String(c).trim().toLowerCase());
    if (real != null && obj[real] != null && obj[real] !== '') return obj[real];
  }
  return undefined;
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function cleanStr(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  return s || null;
}

// ── parseo del archivo ─────────────────────────────────────────────────────

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
        if (String(k).toLowerCase().trim().startsWith('__empty')) continue;
        out[k] = row[k];
      }
      return out;
    })
    .filter(r => Object.values(r).some(v => v != null && v !== ''));

  if (!cleaned.length) throw new Error('El archivo no contiene filas de datos');
  return cleaned;
}

// ── normalización de cada fila ─────────────────────────────────────────────

// mapeo: { COL_ORIGINAL: 'codigo'|'nombre'|'precio'|'rubro'|'subrubro'|'ignorar' }
// Si viene mapeo del usuario, buscar directamente por la columna asignada
function resolverConMapeo(row, mapeo, campo) {
  if (!mapeo || !Object.keys(mapeo).length) return undefined;
  for (const [col, rol] of Object.entries(mapeo)) {
    if (rol === campo && row[col] != null && row[col] !== '') return row[col];
  }
  return undefined;
}

function normalizeRow(row, idx, mapeo = {}) {
  try {
    // articulo_id: si hay mapeo del usuario, usarlo; sino detectar automático
    const codigoRaw = resolverConMapeo(row, mapeo, 'codigo') ?? getCI(row, [
      'codigo', 'cod_rua', 'codrua', 'cod_ru', 'articulo_id', 'art_id', 'code', 'id',
    ]);

    if (codigoRaw == null) throw new Error('Sin código identificador');

    const articulo_id = parseInt(String(codigoRaw).trim(), 10);
    if (!Number.isFinite(articulo_id) || articulo_id <= 0) {
      throw new Error(`Código inválido: "${codigoRaw}"`);
    }

    const nombreRaw = resolverConMapeo(row, mapeo, 'nombre') ?? getCI(row, ['nombre', 'name', 'descripcion', 'descripción', 'denominacion']);
    if (!nombreRaw) throw new Error(`Nombre vacío en código ${articulo_id}`);
    const nombre = cleanStr(String(nombreRaw)) || '';
    if (!nombre) throw new Error(`Nombre vacío en código ${articulo_id}`);

    // Categoría: si hay COD_RUA usarlo como código numérico que luego se cruza con rubros
    const categoriaRaw = resolverConMapeo(row, mapeo, 'rubro') ?? getCI(row, [
      'categoria', 'categoría', 'rubro', 'cat', 'categoria_nombre', 'rubro_nombre',
    ]);
    const categoria = categoriaRaw != null && String(categoriaRaw).trim() !== ''
      ? String(categoriaRaw).trim()
      : 'Sin categoría';

    // COD_SUA como subrubro
    const subrubroRaw = resolverConMapeo(row, mapeo, 'subrubro') ?? getCI(row, ['subrubro', 'subcategoria', 'sub', 'cod_sua', 'codsua']);
    const subrubro = subrubroRaw != null && String(subrubroRaw).trim() !== ''
      ? String(subrubroRaw).trim()
      : null;

    // Precio: si hay mapeo, usar esa columna; sino detectar
    const precio = parseNum(
      resolverConMapeo(row, mapeo, 'precio') ?? getCI(row, ['precio1', 'precio', 'price', 'precio_venta', 'precio_ref', 'p_ref', 'precio2'])
    ) ?? 0;

    return {
      ok: true,
      data: { articulo_id, nombre, categoria, subrubro, precio },
    };
  } catch (e) {
    return { ok: false, error: e.message, row: idx + 1 };
  }
}

// ── función principal ──────────────────────────────────────────────────────

async function importArticulosFromFile({ businessId, filePath, originalName, mapeo = {} }) {
  const client = await pool.connect();
  let txOpen = false;

  try {
    // Resolver siempre al negocio principal de la organización
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

    const errors = [];
    const items  = [];
    for (let i = 0; i < rawRows.length; i++) {
      const norm = normalizeRow(rawRows[i], i, mapeo);
      if (!norm.ok) errors.push({ row: i + 2, error: norm.error }); // +2: header + 1-based
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

    const batchId = `csv-art-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    await client.query('BEGIN');
    txOpen = true;

    let inserted = 0, updated = 0;
    const CHUNK = 200;

    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);

      const values = [];
      const params = [];
      let p = 1;

      for (const it of chunk) {
        values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},'{}'::jsonb,NOW(),$${p+6},'csv')`);
        params.push(
          targetBizId,
          it.articulo_id,
          it.nombre,
          it.categoria,
          it.subrubro,
          it.precio,
          batchId,
        );
        p += 7;
      }

      const res = await client.query(
        `INSERT INTO maxi_articles
           (business_id, articulo_id, nombre, categoria, subrubro, precio, raw, updated_at, upload_batch_id, origen)
         VALUES ${values.join(',')}
         ON CONFLICT (business_id, articulo_id) DO UPDATE SET
           nombre          = EXCLUDED.nombre,
           categoria       = CASE
                               WHEN EXCLUDED.categoria !~ '^[0-9]+$'
                               THEN EXCLUDED.categoria
                               -- Si viene como número y la cat actual no es número → respetamos la actual
                               WHEN maxi_articles.categoria IS NOT NULL
                                AND maxi_articles.categoria !~ '^[0-9]+$'
                                AND maxi_articles.categoria != 'Sin categoría'
                               THEN maxi_articles.categoria
                               ELSE EXCLUDED.categoria
                             END,
           subrubro        = COALESCE(EXCLUDED.subrubro, maxi_articles.subrubro),
           precio          = EXCLUDED.precio,
           upload_batch_id = EXCLUDED.upload_batch_id,
           origen          = COALESCE(maxi_articles.origen, EXCLUDED.origen),
           updated_at      = NOW()
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

    console.log(`[csvArticulosImport] biz=${targetBizId} batch=${batchId} inserted=${inserted} updated=${updated} errors=${errors.length}`);

    return {
      ok: true,
      summary: {
        total_rows: rawRows.length,
        inserted,
        updated,
        failed:    errors.length,
        has_errors: errors.length > 0,
        target_business_id: targetBizId,
        batch_id: batchId,
      },
      errors: errors.slice(0, 20),
    };

  } catch (error) {
    if (txOpen) { try { await client.query('ROLLBACK'); } catch { } }
    console.error('[CSV Articulos Import] Error fatal:', error.message);
    try { fs.unlinkSync(filePath); } catch { }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { importArticulosFromFile, parseFile };