// services/csvInsumosImportService.js
'use strict';

/**
 * Importación CSV de insumos desde MaxiRest.
 *
 * MaxiRest exporta insumos desde: Stock → Insumos → Excel
 * Columnas esperadas (case-insensitive):
 *   CODIGO | NOMBRE | RUBRO | MEDIDA | PRECIO | DISCONTINUADO
 *
 * Estrategia:
 *   - Upsert por (business_id, codigo_maxi) — igual que la sync de API
 *   - Si el insumo ya existe → actualiza nombre, unidad, precio, rubro
 *   - Si no existe → lo crea con origen='csv'
 *   - Los insumos que NO vienen en el CSV no se tocan (no se borran)
 *   - NUNCA borra — solo agrega/actualiza
 *   - Funciona para completar catálogos parciales (21 faltantes de San Justo, etc.)
 */

const pool = require('../config/db');
const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

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

function parseBool(v) {
  if (v == null || v === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'si' || s === 'sí' || s === 's';
}

// ── parseo del archivo ────────────────────────────────────────────────────────

async function parseFile(filePath) {
  const workbook = XLSX.readFile(filePath, { type: 'file', raw: true });
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
      `El archivo debe tener al menos: CODIGO y NOMBRE.`
    );
  }

  return cleaned;
}

function normalizeRow(row, idx) {
  try {
    const codigoRaw = String(getCI(row, ['codigo', 'code', 'cod']) ?? '').trim();
    const codigo    = parseInt(codigoRaw, 10);
    if (!codigoRaw || !Number.isFinite(codigo) || codigo <= 0) {
      throw new Error(`Código inválido: "${codigoRaw}"`);
    }

    const nombre = String(getCI(row, ['nombre', 'name', 'descripcion', 'descripción']) ?? '').trim();
    if (!nombre) throw new Error(`Nombre vacío en código ${codigo}`);

    const rubro        = parseInt(String(getCI(row, ['rubro', 'categoria', 'categoría', 'category']) ?? ''), 10);
    const unidad_med   = String(getCI(row, ['medida', 'unidad', 'unidad_med', 'unit', 'u.med']) ?? '').trim() || null;
    const precio_ref   = parseNum(getCI(row, ['precio', 'price', 'precio_ref', 'p_ref']));
    const discontinuado = parseBool(getCI(row, ['discontinuado', 'discontinuados', 'disc', 'baja']));

    return {
      ok: true,
      data: {
        codigo_maxi:  String(codigo),
        nombre,
        rubro:        Number.isFinite(rubro) && rubro > 0 ? rubro : null,
        unidad_med,
        precio_ref,
        discontinuado,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message, row: idx + 1 };
  }
}

// ── función principal ─────────────────────────────────────────────────────────

async function importInsumosFromFile({ businessId, userId, filePath, originalName, fileType }) {
  const client = await pool.connect();
  let txOpen = false;

  try {
    // Resolver siempre al negocio principal (insumos = recurso global)
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
    const errors  = [];
    const items   = [];
    for (let i = 0; i < rawRows.length; i++) {
      const norm = normalizeRow(rawRows[i], i);
      if (!norm.ok) {
        errors.push({ row: i + 1, error: norm.error });
      } else {
        items.push(norm.data);
      }
    }

    if (!items.length) {
      try { fs.unlinkSync(filePath); } catch { }
      return {
        ok: false,
        error: 'no_valid_rows',
        summary: { total_rows: rawRows.length, inserted: 0, updated: 0, failed: errors.length },
        errors: errors.slice(0, 20),
      };
    }

    // Upsert en lotes
    await client.query('BEGIN');
    txOpen = true;

    // Generar batch ID único para este import
    const batchId = `csv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    let inserted = 0, updated = 0;
    const CHUNK = 200;

    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);

      for (const it of chunk) {
        // estado: si está marcado como discontinuado en MaxiRest → inactivo, sino activo
        const estado = it.discontinuado ? 'inactivo' : 'activo';

        const r = await client.query(
          `INSERT INTO insumos
             (business_id, codigo_maxi, nombre, unidad_med, precio_ref, rubro, origen, estado, upload_batch_id, sin_equivalencia)
           VALUES ($1, $2, $3, $4, $5, $6, 'csv', $7, $8, false)
           ON CONFLICT (business_id, codigo_maxi) DO UPDATE SET
             nombre          = EXCLUDED.nombre,
             unidad_med      = EXCLUDED.unidad_med,
             precio_ref      = EXCLUDED.precio_ref,
             rubro           = EXCLUDED.rubro,
             estado          = EXCLUDED.estado,
             upload_batch_id = EXCLUDED.upload_batch_id,
             updated_at      = NOW()
           RETURNING (xmax = 0) AS is_insert`,
          [targetBizId, it.codigo_maxi, it.nombre, it.unidad_med,
           it.precio_ref, it.rubro, estado, batchId]
        );

        if (r.rows[0]?.is_insert) inserted++; else updated++;
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
        batch_id: batchId,
      },
      errors: errors.slice(0, 20),
    };

  } catch (error) {
    if (txOpen) { try { await client.query('ROLLBACK'); } catch { } }
    console.error('[CSV Insumos Import] Error fatal:', error);
    try { fs.unlinkSync(filePath); } catch { }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { importInsumosFromFile };