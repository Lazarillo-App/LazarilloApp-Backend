// services/csvRecetasImportService.js
'use strict';

/**
 * Importación CSV de recetas desde archivo Excel.
 *
 * Formato esperado (exportable desde MaxiRest o armado manual):
 *
 *   CODIGO_ARTICULO | NOMBRE_ARTICULO | CODIGO_INSUMO | NOMBRE_INSUMO | CANTIDAD | UNIDAD | OBSERVACIONES
 *         51        | Fainá           |      1        | Harina garb.  |   0.3    |  Kg    |
 *         51        | Fainá           |      2        | Agua           |   0.85   |  Lt    |
 *         51        | Fainá           |     10        | Sal            |   2.3    |  Cchrd |
 *         360       | Adicional Crema |      5        | Crema          |   0.2    |  Lt    |
 *
 * Una fila = un ingrediente.
 * Varios artículos en el mismo archivo = OK.
 *
 * Estrategia:
 *   - Agrupar filas por CODIGO_ARTICULO
 *   - Por cada artículo: upsert en recetas (article_id, business_id)
 *   - Por cada ingrediente: cruzar CODIGO_INSUMO → insumos.codigo_maxi → insumos.id
 *   - DELETE + INSERT de receta_items
 *   - Si el insumo no existe → guardar con insumo_id=null + codigo_maxi_insumo para resolución futura
 *   - Si el artículo no existe en maxi_articles → registrar como warning, no importar esa receta
 *   - NUNCA borra recetas que no aparecen en el CSV (solo actualiza las que sí)
 */

const pool = require('../config/db');
const XLSX = require('xlsx');
const fs   = require('fs');

// ── helpers ──────────────────────────────────────────────────────────────────

function getCI(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  const map = new Map();
  for (const k of Object.keys(obj)) map.set(String(k).trim().toLowerCase().replace(/\s+/g, '_'), k);
  for (const candidate of keys) {
    const real = map.get(String(candidate).trim().toLowerCase().replace(/\s+/g, '_'));
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
  const workbook = XLSX.readFile(filePath, { type: 'file', raw: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('El archivo no contiene hojas');

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: true, defval: null });
  const cleaned = rows
    .map(row => {
      const out = {};
      for (const k of Object.keys(row)) {
        if (String(k).toLowerCase().startsWith('__empty')) continue;
        out[k] = row[k];
      }
      return out;
    })
    .filter(r => Object.values(r).some(v => v != null && v !== ''));

  if (!cleaned.length) throw new Error('El archivo no contiene filas de datos');

  const headersLower = Object.keys(cleaned[0] || {}).map(h => h.toLowerCase().trim());
  const hasCodArticulo = ['codigo_articulo', 'cod_articulo', 'artcode', 'art_code', 'codigo art', 'cod art']
    .some(k => headersLower.includes(k));
  const hasCodInsumo = ['codigo_insumo', 'cod_insumo', 'inscode', 'ins_code', 'codigo ins', 'cod ins']
    .some(k => headersLower.includes(k));

  if (!hasCodArticulo || !hasCodInsumo) {
    throw new Error(
      `Columnas faltantes. El archivo debe tener: CODIGO_ARTICULO y CODIGO_INSUMO. ` +
      `Columnas encontradas: ${headersLower.join(', ')}`
    );
  }

  return cleaned;
}

function normalizeRow(row, idx) {
  try {
    const codArtRaw = String(
      getCI(row, ['codigo_articulo', 'cod_articulo', 'artcode', 'art_code', 'codigo art', 'cod art', 'articulo']) ?? ''
    ).trim();
    const codArt = parseInt(codArtRaw, 10);
    if (!codArtRaw || !Number.isFinite(codArt) || codArt <= 0) {
      throw new Error(`CODIGO_ARTICULO inválido: "${codArtRaw}"`);
    }

    const codInsRaw = String(
      getCI(row, ['codigo_insumo', 'cod_insumo', 'inscode', 'ins_code', 'codigo ins', 'cod ins', 'insumo']) ?? ''
    ).trim();
    const codIns = parseInt(codInsRaw, 10);
    if (!codInsRaw || !Number.isFinite(codIns) || codIns <= 0) {
      throw new Error(`CODIGO_INSUMO inválido en art ${codArt}: "${codInsRaw}"`);
    }

    const cantidad = parseNum(
      getCI(row, ['cantidad', 'cant', 'insCant', 'ins_cant', 'qty'])
    );
    if (!cantidad || cantidad <= 0) {
      throw new Error(`Cantidad inválida en art ${codArt} ins ${codIns}: "${cantidad}"`);
    }

    const nombreArticulo = String(
      getCI(row, ['nombre_articulo', 'nom_articulo', 'recname', 'rec_name', 'nombre art', 'articulo_nombre']) ?? ''
    ).trim() || null;

    const nombreInsumo = String(
      getCI(row, ['nombre_insumo', 'nom_insumo', 'insname', 'ins_name', 'nombre ins', 'insumo_nombre']) ?? ''
    ).trim() || null;

    const unidad = String(
      getCI(row, ['unidad', 'unit', 'insunit', 'ins_unit', 'u_med', 'unidad_med']) ?? 'u'
    ).trim() || 'u';

    const observaciones = String(
      getCI(row, ['observaciones', 'obs', 'insobs', 'ins_obs', 'notas', 'notes']) ?? ''
    ).trim() || null;

    return {
      ok: true,
      data: {
        codArt,
        nombreArticulo,
        codIns:    String(codIns),
        nombreInsumo,
        cantidad,
        unidad,
        observaciones,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message, row: idx + 1 };
  }
}

// ── función principal ─────────────────────────────────────────────────────────

async function importRecetasFromFile({ businessId, filePath }) {
  const client = await pool.connect();
  let txOpen = false;

  try {
    // Resolver al negocio principal
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
      const norm = normalizeRow(rawRows[i], i);
      if (!norm.ok) errors.push({ row: i + 1, error: norm.error });
      else items.push(norm.data);
    }

    if (!items.length) {
      try { fs.unlinkSync(filePath); } catch {}
      return {
        ok: false, error: 'no_valid_rows',
        summary: { total_rows: rawRows.length, recetas_upserted: 0, items_saved: 0, failed: errors.length },
        errors: errors.slice(0, 20),
      };
    }

    // Precargar mapa codigo_maxi → insumo_id
    const { rows: insumoRows } = await pool.query(
      `SELECT id, codigo_maxi FROM insumos WHERE business_id = $1`,
      [targetBizId]
    );
    const insumoByCode = new Map(insumoRows.map(r => [String(r.codigo_maxi), Number(r.id)]));

    // Agrupar items por artículo
    const articulosMap = new Map(); // codArt → { nombreArticulo, items[] }
    for (const it of items) {
      if (!articulosMap.has(it.codArt)) {
        articulosMap.set(it.codArt, { nombreArticulo: it.nombreArticulo, items: [] });
      }
      articulosMap.get(it.codArt).items.push(it);
    }

    await client.query('BEGIN');
    txOpen = true;

    let recetas_upserted = 0, items_saved = 0;
    const warnings = [];

    for (const [codArt, grupo] of articulosMap.entries()) {
      // Verificar que el artículo existe
      const { rows: artRows } = await client.query(
        `SELECT articulo_id, nombre FROM maxi_articles WHERE business_id = $1 AND articulo_id = $2 LIMIT 1`,
        [targetBizId, codArt]
      );
      if (!artRows.length) {
        warnings.push(`Artículo ${codArt} no encontrado en el catálogo — receta omitida`);
        continue;
      }

      const nombreReceta = grupo.nombreArticulo || artRows[0].nombre || null;

      // Upsert receta
      const { rows: recetaRows } = await client.query(
        `INSERT INTO recetas
           (article_id, business_id, nombre, descripcion, porciones,
            porcentaje_venta, costo_total, active, origen, created_at, updated_at)
         VALUES ($1, $2, $3, '', 1, 0, 0, TRUE, 'csv', NOW(), NOW())
         ON CONFLICT (article_id, business_id) DO UPDATE SET
           nombre     = EXCLUDED.nombre,
           active     = TRUE,
           origen     = CASE WHEN recetas.origen = 'manual' THEN 'manual' ELSE 'csv' END,
           updated_at = NOW()
         RETURNING id`,
        [codArt, targetBizId, nombreReceta]
      );

      const recetaId = recetaRows[0].id;
      recetas_upserted++;

      // Reemplazar items
      await client.query(`DELETE FROM receta_items WHERE receta_id = $1`, [recetaId]);

      for (let i = 0; i < grupo.items.length; i++) {
        const it    = grupo.items[i];
        const insId = insumoByCode.get(it.codIns) ?? null;

        await client.query(
          `INSERT INTO receta_items
             (receta_id, insumo_id, codigo_maxi_insumo, nombre_insumo_maxi,
              cantidad, unidad, costo_unitario, notas, orden, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, NOW(), NOW())`,
          [recetaId, insId, it.codIns, it.nombreInsumo, it.cantidad, it.unidad, it.observaciones, i]
        );
        items_saved++;
      }
    }

    await client.query('COMMIT');
    txOpen = false;

    try { fs.unlinkSync(filePath); } catch {}

    return {
      ok: true,
      summary: {
        total_rows:        rawRows.length,
        recetas_upserted,
        items_saved,
        failed:            errors.length,
        warnings:          warnings.length,
        target_business_id: targetBizId,
      },
      errors:   errors.slice(0, 20),
      warnings: warnings.slice(0, 20),
    };

  } catch (error) {
    if (txOpen) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('[CSV Recetas Import] Error fatal:', error);
    try { fs.unlinkSync(filePath); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { importRecetasFromFile };