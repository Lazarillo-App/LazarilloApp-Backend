// services/csvSalesImportService.js
const pool = require('../config/db');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { rebuildSalesDailyRange } = require('./salesDailyRebuildService');
const { VERBOSE_IMPORT_LOGS, MAX_IMPORT_ROWS } = require('../config/features');

/**
 * Helpers: obtener valor por key de forma case-insensitive
 */
function getByKeysCI(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;

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
 */
async function parseFile(filePath, fileType) {
  try {
    const readOpts = {
      type: 'file',
      cellDates: true,
      raw: true,
    };

    const workbook = XLSX.readFile(filePath, readOpts);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('El archivo no contiene hojas');

    const worksheet = workbook.Sheets[sheetName];

    const rows = XLSX.utils.sheet_to_json(worksheet, {
      raw: true,
      defval: null,
    });

    // Filtrar columnas autogeneradas por Excel
    const cleanedRows = rows.map(row => {
      const cleaned = {};
      for (const key of Object.keys(row)) {
        const keyLower = String(key).toLowerCase().trim();
        if (keyLower.startsWith('import_') ||
          keyLower.startsWith('__empty') ||
          keyLower === 'import #') {
          continue;
        }
        cleaned[key] = row[key];
      }
      return cleaned;
    });

    const headers = Object.keys(cleanedRows[0] || {});

    if (VERBOSE_IMPORT_LOGS) {
      console.log('[CSV Parse] Headers detectados:', headers);
      console.log('[CSV Parse] Primera fila limpia:', cleanedRows[0]);
    }

    // Validación: solo permitir columnas conocidas
    const allowedColumns = [
      'codigo', 'fecha', 'unidades', 'importe', 'nombre',
      'costo', 'p_total', 'neto', 'tipo_iva',
      'article_id', 'date', 'qty', 'amount', 'article_name',
    ];

    const allowedLower = allowedColumns.map(c => c.toLowerCase());
    const unknownColumns = headers.filter(h => {
      const lower = String(h).toLowerCase().trim();
      return !allowedLower.includes(lower);
    });

    if (unknownColumns.length > 0) {
      throw new Error(
        `Archivo contiene columnas no permitidas: ${unknownColumns.join(', ')}. ` +
        `Solo se permiten: ${allowedColumns.slice(0, 5).join(', ')}, etc. ` +
        `Asegurate de exportar el archivo correcto desde MaxiRest.`
      );
    }

    return { headers, rows: cleanedRows };
  } catch (error) {
    throw new Error(`Error parseando archivo: ${error.message}`);
  }
}

/**
 * Detecta el formato del archivo basándose en las columnas
 */
function detectFormat(headers) {
  const lowerHeaders = headers.map(h => String(h).toLowerCase().trim());

  const maxiFormat = ['codigo', 'fecha', 'unidades', 'importe'];
  const hasMaxi = maxiFormat.every(col => lowerHeaders.includes(col));
  if (hasMaxi) return 'maxi_export';

  const basicFormat = ['article_id', 'date', 'qty', 'amount'];
  const hasBasic = basicFormat.every(col => lowerHeaders.includes(col));
  if (hasBasic) return 'basic';

  return null;
}

/**
 * Normaliza una fecha a YYYY-MM-DD.
 */
function normalizeDate(dateValue) {
  if (dateValue == null || dateValue === '') return null;

  if (dateValue instanceof Date && !isNaN(dateValue.getTime())) {
    return dateValue.toISOString().slice(0, 10);
  }

  if (typeof dateValue === 'number' && Number.isFinite(dateValue)) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(excelEpoch.getTime() + dateValue * 86400000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  const s = String(dateValue).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // DD/MM/YY o DD/MM/YYYY
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    let yy = parseInt(m[3], 10);
    if (m[3].length === 2) yy = yy <= 69 ? 2000 + yy : 1900 + yy;
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
    if (m[3].length === 2) yy = yy <= 69 ? 2000 + yy : 1900 + yy;
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
      const d = new Date(Date.UTC(yy, mm - 1, dd));
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    return null;
  }

  if (/^\d{4}\//.test(s) || /^\d{4}\./.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  return null;
}

/**
 * Valida y normaliza una fila
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
      dateField = getByKeysCI(row, ['fecha']);
      idField = getByKeysCI(row, ['codigo']);
      qtyField = getByKeysCI(row, ['unidades']);
      amountField = getByKeysCI(row, ['importe']);
      nameField = getByKeysCI(row, ['nombre']);
    } else {
      dateField = getByKeysCI(row, ['date', 'fecha']);
      idField = getByKeysCI(row, ['article_id', 'codigo']);
      qtyField = getByKeysCI(row, ['qty', 'unidades']);
      amountField = getByKeysCI(row, ['amount', 'importe']);
      nameField = getByKeysCI(row, ['article_name', 'nombre']);
    }

    normalized.date = normalizeDate(dateField);
    if (!normalized.date) {
      throw new Error(`Fecha inválida o faltante: "${dateField}"`);
    }

    const rawId = String(idField ?? '').trim();
    normalized.article_id = rawId === '' ? 0 : parseInt(rawId, 10);

    if (!Number.isFinite(normalized.article_id) || normalized.article_id < 0) {
      throw new Error(`ID de artículo inválido: "${idField}" (debe ser número >= 0)`);
    }

    normalized.qty = parseFloat(String(qtyField ?? '').replace(',', '.'));
    if (!Number.isFinite(normalized.qty)) {
      throw new Error(`Cantidad inválida: "${qtyField}"`);
    }

    normalized.amount = parseFloat(String(amountField ?? '').replace(',', '.'));
    if (!Number.isFinite(normalized.amount)) {
      throw new Error(`Importe inválido: "${amountField}"`);
    }

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

/* ============================================================
   Helpers: staging + overlap + diff + apply replace
   ============================================================ */

async function insertStagingItems(client, { importId, businessId, items }) {
  await client.query('DELETE FROM sales_csv_import_items WHERE import_id = $1', [importId]);

  const CHUNK = 1000;

  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);

    const params = [];
    const rowsSql = chunk.map((r, idx) => {
      const base = idx * 7;
      params.push(importId, businessId, r.day, r.article_id, r.qty, r.amount, r.article_name);
      return `($${base + 1}, $${base + 2}, $${base + 3}::date, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    }).join(',');

    await client.query(`
      INSERT INTO sales_csv_import_items
        (import_id, business_id, day, article_id, qty, amount, article_name)
      VALUES ${rowsSql}
      ON CONFLICT (import_id, day, article_id)
      DO UPDATE SET
        qty = EXCLUDED.qty,
        amount = EXCLUDED.amount,
        article_name = COALESCE(EXCLUDED.article_name, sales_csv_import_items.article_name)
    `, params);
  }
}

async function applyReplaceRange(client, { businessId, from, to, importId }) {
  await client.query(`
    DELETE FROM sales_daily_items
    WHERE business_id = $1
      AND source='csv'
      AND day BETWEEN $2::date AND $3::date
  `, [businessId, from, to]);

  const ins = await client.query(`
    INSERT INTO sales_daily_items
      (business_id, day, article_id, qty, amount, article_name, source, created_at, updated_at)
    SELECT
      business_id, day, article_id, qty, amount, article_name,
      'csv', NOW(), NOW()
    FROM sales_csv_import_items
    WHERE import_id = $1
  `, [importId]);

  return ins.rowCount || 0;
}

/**
 * Importa archivo a la base de datos.
 *
 * El CSV se guarda SIEMPRE con el business_id del negocio activo (el que viene
 * en el request). No hay redirección al negocio principal. Esto permite que
 * cada subnegocio tenga sus propios datos de ventas aislados.
 *
 * Regla de solapamiento:
 * - si NO solapa: aplica directo (replace por rango) → status "completed"
 * - si SÍ solapa: deja en "awaiting_approval" + change_set + notificación
 */
async function importFileToDatabase({ businessId, userId, filePath, originalName, fileType }) {
  const client = await pool.connect();
  let importId = null;
  let txOpen = false;

  try {
    await client.query('BEGIN');
    txOpen = true;

    // El businessId que llega es el negocio activo. Se usa directamente, sin
    // redirigir al principal. Cada negocio gestiona sus propias ventas.
    const salesBusinessId = businessId;

    if (VERBOSE_IMPORT_LOGS) {
      console.log(`[CSV Import] Iniciando importación para business ${salesBusinessId}`);
    }

    // 1) Crear registro de importación
    const { rows: [importRecord] } = await client.query(`
      INSERT INTO sales_csv_imports
        (business_id, user_id, filename, original_name, file_size, file_type, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'processing')
      RETURNING id
    `, [
      salesBusinessId,
      userId,
      path.basename(filePath),
      originalName,
      fs.statSync(filePath).size,
      fileType,
    ]);

    importId = importRecord.id;

    if (VERBOSE_IMPORT_LOGS) {
      console.log(`[CSV Import] Registro creado #${importId} para business ${salesBusinessId}`);
    }

    // 2) Parsear
    const { headers, rows } = await parseFile(filePath, fileType);

    if (rows.length === 0) {
      throw new Error('El archivo no contiene filas de datos.');
    }

    if (VERBOSE_IMPORT_LOGS) {
      console.log(`[CSV Import] Parseado: ${rows.length} filas, columnas:`, headers);
    }

    if (rows.length > MAX_IMPORT_ROWS) {
      throw new Error(
        `El archivo excede el límite de ${MAX_IMPORT_ROWS} filas. Actual: ${rows.length}. Dividí el archivo en partes.`
      );
    }

    // 3) Detectar formato
    const format = detectFormat(headers);
    if (!format) {
      throw new Error(
        `Formato no reconocido. Columnas detectadas: ${headers.join(', ')}. Se esperan: fecha, codigo, unidades, importe`
      );
    }

    if (VERBOSE_IMPORT_LOGS) {
      console.log(`[CSV Import] Formato detectado: ${format}`);
    }

    // 4) Normalizar filas + agregación (day+article_id)
    let failed = 0;
    const errors = [];
    let minDate = null;
    let maxDate = null;

    const agg = new Map(); // key: `${date}|${article_id}`

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

      // Nunca guardar datos del día actual (puede estar incompleto)
      const todayUTC = new Date().toISOString().slice(0, 10);
      if (date === todayUTC) continue;

      const key = `${date}|${article_id}`;
      const prev = agg.get(key);
      if (!prev) {
        agg.set(key, { day: date, article_id, qty, amount, article_name });
      } else {
        prev.qty += qty;
        prev.amount += amount;
        if (!prev.article_name && article_name) prev.article_name = article_name;
      }
    }

    if (!minDate || !maxDate) {
      await client.query(`
        UPDATE sales_csv_imports
        SET
          status = 'failed',
          row_count = $2,
          rows_failed = $3,
          error_log = $4::jsonb,
          processed_at = NOW()
        WHERE id = $1
      `, [importId, rows.length, failed, JSON.stringify(errors)]);
      await client.query('COMMIT');
      txOpen = false;

      try { fs.unlinkSync(filePath); } catch { }

      return {
        ok: false,
        import_id: importId,
        error: 'no_valid_rows',
        summary: {
          total_rows: rows.length,
          failed,
          has_errors: true,
          date_range: { from: null, to: null },
        },
        errors: errors.slice(0, 20),
      };
    }

    const items = Array.from(agg.values());

    // 5) Guardar en staging
    await insertStagingItems(client, { importId, businessId: salesBusinessId, items });

    // 6) Detectar solapamiento contra CSV previo del mismo negocio
    // Siempre aplicar replace: el último archivo importado es la fuente de verdad.
    // DELETE del rango completo + INSERT desde staging elimina automáticamente
    // registros que ya no están en el nuevo informe.
    let mode = 'applied';
    let appliedRows = 0;

    appliedRows = await applyReplaceRange(client, {
      businessId: salesBusinessId,
      from: minDate,
      to: maxDate,
      importId,
    });

    // Reconstruir sales_daily priorizando CSV sobre Maxi
    await rebuildSalesDailyRange({
      businessId: salesBusinessId,
      from: minDate,
      to: maxDate,
      client,
    });

    await client.query(`
  UPDATE sales_csv_imports
  SET
    status = $2,
    row_count = $3,
    date_from = $4::date,
    date_to = $5::date,
    rows_inserted = $6,
    rows_updated = 0,
    rows_failed = $7,
    error_log = $8::jsonb,
    processed_at = NOW()
  WHERE id = $1
`, [
      importId,
      failed === rows.length ? 'failed' : 'completed',
      rows.length,
      minDate,
      maxDate,
      appliedRows,
      failed,
      JSON.stringify(errors),
    ]);

    await client.query('COMMIT');
    txOpen = false;

    try { fs.unlinkSync(filePath); } catch { }

    if (VERBOSE_IMPORT_LOGS) {
      console.log(`[CSV Import] Completado #${importId}: mode=${mode}, rows=${appliedRows}`);
    }

    return {
      ok: true,
      mode,
      import_id: importId,
      summary: {
        total_rows: rows.length,
        valid_rows: items.length,
        inserted: appliedRows,
        failed,
        has_errors: failed > 0,
        date_range: { from: minDate, to: maxDate },
        applied_rows: appliedRows,
      },
      errors: errors.slice(0, 20),
    };

  } catch (error) {
    if (txOpen) {
      try { await client.query('ROLLBACK'); } catch { }
      txOpen = false;
    }

    console.error('[CSV Import] Error fatal:', error);

    if (importId) {
      try {
        await pool.query(`
          UPDATE sales_csv_imports
          SET status = 'failed',
              error_log = $2::jsonb,
              processed_at = NOW()
          WHERE id = $1
        `, [importId, JSON.stringify([{ error: error.message }])]);
      } catch { }
    }

    try { fs.unlinkSync(filePath); } catch { }

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
  getImportDetails,
  applyReplaceRange,
};