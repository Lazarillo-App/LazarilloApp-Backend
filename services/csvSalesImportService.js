// services/csvSalesImportService.js
const pool = require('../config/db');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { VERBOSE_IMPORT_LOGS, MAX_IMPORT_ROWS } = require('../config/features');

/**
 * Helpers: obtener valor por key de forma case-insensitive
 */
function getByKeysCI(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;

  // mapa de keys normalizadas -> key real
  const map = new Map();
  for (const k of Object.keys(obj)) {
    map.set(String(k).trim().toLowerCase(), k);
  }

  for (const candidate of keys) {
    const norm = String(candidate).trim().toLowerCase();
    const realKey = map.get(norm);
    if (realKey != null) return obj[realKey];
  }
  return undefined;
}

/**
 * Parsea archivo Excel (XLS/XLSX) o CSV
 * Nota: XLSX puede leer CSV también.
 */
async function parseFile(filePath, fileType) {
  try {
    const readOpts = {
      type: 'file',
      cellDates: true,  // <-- clave: traer Date cuando Excel es fecha
      raw: true,        // <-- evitar que XLSX "formatee" strings ambiguos
    };

    const workbook = XLSX.readFile(filePath, readOpts);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('El archivo no contiene hojas');

    const worksheet = workbook.Sheets[sheetName];

    const data = XLSX.utils.sheet_to_json(worksheet, {
      raw: true,
      defval: null,
    });

    const headers = Object.keys(data[0] || {});
    return { headers, rows: data };
  } catch (error) {
    throw new Error(`Error parseando archivo: ${error.message}`);
  }
}

/**
 * Detecta el formato del archivo basándose en las columnas
 */
function detectFormat(headers) {
  const lowerHeaders = headers.map(h => String(h).toLowerCase().trim());

  // Formato Maxi Export
  const maxiFormat = ['codigo', 'fecha', 'unidades', 'importe'];
  const hasMaxi = maxiFormat.every(col => lowerHeaders.includes(col));
  if (hasMaxi) return 'maxi_export';

  // Formato básico genérico
  const basicFormat = ['article_id', 'date', 'qty', 'amount'];
  const hasBasic = basicFormat.every(col => lowerHeaders.includes(col));
  if (hasBasic) return 'basic';

  return null;
}

/**
 * Normaliza una fecha a YYYY-MM-DD.
 * Soporta:
 * - Date object
 * - Excel serial (number)
 * - "YYYY-MM-DD"
 * - "DD/MM/YY" y "DD/MM/YYYY"
 * - "DD-MM-YY" y "DD-MM-YYYY"
 *
 * Ojo: NO usamos new Date("10/4/25") porque es ambiguo (MM/DD vs DD/MM).
 */
function normalizeDate(dateValue) {
  if (dateValue == null || dateValue === '') return null;

  // Date object (si cellDates=true)
  if (dateValue instanceof Date && !isNaN(dateValue.getTime())) {
    return dateValue.toISOString().slice(0, 10);
  }

  // Excel serial date
  if (typeof dateValue === 'number' && Number.isFinite(dateValue)) {
    // Excel epoch: 1899-12-30 (para compatibilidad)
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(excelEpoch.getTime() + dateValue * 86400000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  const s = String(dateValue).trim();

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // DD/MM/YY o DD/MM/YYYY
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    let yy = parseInt(m[3], 10);

    if (m[3].length === 2) {
      // 00-69 => 2000-2069, 70-99 => 1970-1999 (ajustable)
      yy = yy <= 69 ? 2000 + yy : 1900 + yy;
    }

    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
      const d = new Date(Date.UTC(yy, mm - 1, dd));
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    return null;
  }

  // DD-MM-YY o DD-MM-YYYY
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/);
  if (m) {
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    let yy = parseInt(m[3], 10);

    if (m[3].length === 2) {
      yy = yy <= 69 ? 2000 + yy : 1900 + yy;
    }

    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
      const d = new Date(Date.UTC(yy, mm - 1, dd));
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    return null;
  }

  // Último recurso: intentar parseo ISO seguro (no ambiguo)
  // (evitamos formatos con / )
  if (/^\d{4}\//.test(s) || /^\d{4}\./.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  return null;
}

/**
 * Valida y normaliza una fila del archivo
 */
function normalizeRow(row, format = 'maxi_export', rowNumber) {
  const normalized = {
    date: null,
    article_id: null,
    qty: null,
    amount: null,
    article_name: null,
  };

  try {
    let dateField, idField, qtyField, amountField, nameField;

    if (format === 'maxi_export') {
      dateField   = getByKeysCI(row, ['fecha']);
      idField     = getByKeysCI(row, ['codigo']);
      qtyField    = getByKeysCI(row, ['unidades']);
      amountField = getByKeysCI(row, ['importe']);
      nameField   = getByKeysCI(row, ['nombre']);
    } else {
      dateField   = getByKeysCI(row, ['date', 'fecha']);
      idField     = getByKeysCI(row, ['article_id', 'codigo']);
      qtyField    = getByKeysCI(row, ['qty', 'unidades']);
      amountField = getByKeysCI(row, ['amount', 'importe']);
      nameField   = getByKeysCI(row, ['article_name', 'nombre']);
    }

    // Fecha (obligatorio)
    normalized.date = normalizeDate(dateField);
    if (!normalized.date) {
      throw new Error(`Fecha inválida o faltante: "${dateField}"`);
    }

    // Article ID (obligatorio)
    normalized.article_id = parseInt(String(idField ?? '').trim(), 10);
    if (!Number.isFinite(normalized.article_id) || normalized.article_id < 0) {
      throw new Error(`ID de artículo inválido: "${idField}"`);
    }

    // Cantidad (obligatorio)
    normalized.qty = parseFloat(String(qtyField ?? '').replace(',', '.'));
    if (!Number.isFinite(normalized.qty)) {
      throw new Error(`Cantidad inválida: "${qtyField}"`);
    }

    // Importe (obligatorio)
    normalized.amount = parseFloat(String(amountField ?? '').replace(',', '.'));
    if (!Number.isFinite(normalized.amount)) {
      throw new Error(`Importe inválido: "${amountField}"`);
    }

    // Nombre (opcional)
    normalized.article_name = nameField != null ? String(nameField).trim() : null;

    return { ok: true, data: normalized };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      row: rowNumber,
      data: row,
    };
  }
}

/**
 * Importa archivo a la base de datos
 */
async function importFileToDatabase({ businessId, userId, filePath, originalName, fileType }) {
  const client = await pool.connect();
  let importId = null;

  try {
    await client.query('BEGIN');

    // 1) Crear registro importación
    const { rows: [importRecord] } = await client.query(`
      INSERT INTO sales_csv_imports
        (business_id, user_id, filename, original_name, file_size, file_type, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'processing')
      RETURNING id
    `, [
      businessId,
      userId,
      path.basename(filePath),
      originalName,
      fs.statSync(filePath).size,
      fileType
    ]);

    importId = importRecord.id;

    if (VERBOSE_IMPORT_LOGS) {
      console.log(`[CSV Import] Iniciando importación #${importId} para business ${businessId}`);
    }

    // 2) Parsear
    const { headers, rows } = await parseFile(filePath, fileType);

    if (rows.length === 0) {
      throw new Error('El archivo no contiene filas de datos.');
    }

    if (VERBOSE_IMPORT_LOGS) {
      console.log(`[CSV Import] Parseado: ${rows.length} filas, columnas:`, headers);
    }

    // límite
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new Error(
        `El archivo excede el límite de ${MAX_IMPORT_ROWS} filas. Actual: ${rows.length}. Dividí el archivo en partes.`
      );
    }

    // 3) Detectar formato
    const format = detectFormat(headers);
    if (!format) {
      throw new Error(
        `Formato no reconocido. Columnas: ${headers.join(', ')}. Esperadas: fecha, codigo, unidades, importe`
      );
    }

    if (VERBOSE_IMPORT_LOGS) {
      console.log(`[CSV Import] Formato detectado: ${format}`);
    }

    // 4) Procesar filas
    let inserted = 0;
    let updated = 0;
    let failed = 0;
    const errors = [];
    let minDate = null;
    let maxDate = null;

    for (let i = 0; i < rows.length; i++) {
      const normalized = normalizeRow(rows[i], format, i + 1);

      if (!normalized.ok) {
        failed++;
        if (errors.length < 100) {
          errors.push({ row: normalized.row, error: normalized.error, sample: normalized.data });
        }
        continue;
      }

      const { date, article_id, qty, amount, article_name } = normalized.data;

      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;

      try {
        const { rows: ret } = await client.query(`
          INSERT INTO sales_daily_items
            (business_id, day, article_id, qty, amount, article_name, source, created_at, updated_at)
          VALUES ($1, $2::date, $3, $4, $5, $6, 'csv', NOW(), NOW())
          ON CONFLICT (business_id, day, article_id, source)
          DO UPDATE SET
            qty = EXCLUDED.qty,
            amount = EXCLUDED.amount,
            article_name = COALESCE(EXCLUDED.article_name, sales_daily_items.article_name),
            updated_at = NOW()
          RETURNING (xmax = 0) AS inserted
        `, [businessId, date, article_id, qty, amount, article_name]);

        if (ret?.[0]?.inserted) inserted++;
        else updated++;
      } catch (dbError) {
        failed++;
        if (errors.length < 100) {
          errors.push({
            row: i + 1,
            error: `Error DB: ${dbError.message}`,
            sample: normalized.data
          });
        }
      }
    }

    // 5) Actualizar import
    await client.query(`
      UPDATE sales_csv_imports
      SET
        status = $2,
        row_count = $3,
        date_from = $4::date,
        date_to = $5::date,
        rows_inserted = $6,
        rows_updated = $7,
        rows_failed = $8,
        error_log = $9::jsonb,
        processed_at = NOW()
      WHERE id = $1
    `, [
      importId,
      failed === rows.length ? 'failed' : 'completed',
      rows.length,
      minDate,
      maxDate,
      inserted,
      updated,
      failed,
      JSON.stringify(errors)
    ]);

    await client.query('COMMIT');

    // 6) limpiar temp
    try { fs.unlinkSync(filePath); } catch {}

    return {
      ok: true,
      import_id: importId,
      summary: {
        total_rows: rows.length,
        inserted,
        updated,
        failed,
        has_errors: failed > 0,
        date_range: { from: minDate, to: maxDate }
      },
      errors: errors.slice(0, 20)
    };

  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[CSV Import] Error fatal:', error);

    if (importId) {
      try {
        await client.query(`
          UPDATE sales_csv_imports
          SET status = 'failed',
              error_log = $2::jsonb,
              processed_at = NOW()
          WHERE id = $1
        `, [importId, JSON.stringify([{ error: error.message }])]);
      } catch {}
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Lista importaciones de un negocio
 */
async function listImports(businessId, { limit = 20 } = {}) {
  const { rows } = await pool.query(`
    SELECT
      id,
      filename,
      original_name,
      file_size,
      file_type,
      status,
      row_count,
      date_from,
      date_to,
      rows_inserted,
      rows_updated,
      rows_failed,
      created_at,
      processed_at,
      CASE
        WHEN error_log IS NOT NULL THEN jsonb_array_length(error_log)
        ELSE 0
      END AS error_count
    FROM sales_csv_imports
    WHERE business_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [businessId, limit]);

  return rows;
}

/**
 * Detalle de import
 */
async function getImportDetails(importId, businessId) {
  const { rows } = await pool.query(`
    SELECT
      id,
      business_id,
      user_id,
      filename,
      original_name,
      file_size,
      file_type,
      status,
      row_count,
      date_from,
      date_to,
      rows_inserted,
      rows_updated,
      rows_failed,
      error_log,
      created_at,
      processed_at
    FROM sales_csv_imports
    WHERE id = $1 AND business_id = $2
    LIMIT 1
  `, [importId, businessId]);

  return rows[0] || null;
}

module.exports = {
  importFileToDatabase,
  listImports,
  getImportDetails
};
