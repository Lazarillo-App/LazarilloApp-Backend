// services/csvSalesImportService.js

const pool = require('../config/db');
const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');
const { rebuildSalesDailyRange }              = require('./salesDailyRebuildService');
const { VERBOSE_IMPORT_LOGS, MAX_IMPORT_ROWS } = require('../config/features');

/* ─── helpers ─── */
function getByKeysCI(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  const map = new Map();
  for (const k of Object.keys(obj)) map.set(String(k).trim().toLowerCase(), k);
  for (const candidate of keys) {
    const realKey = map.get(String(candidate).trim().toLowerCase());
    if (realKey != null) return obj[realKey];
  }
  return undefined;
}

async function parseFile(filePath, fileType) {
  try {
    const workbook  = XLSX.readFile(filePath, { type: 'file', cellDates: true, raw: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('El archivo no contiene hojas');
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { raw: true, defval: null });

    const cleanedRows = rows.map(row => {
      const cleaned = {};
      for (const key of Object.keys(row)) {
        const keyLower = String(key).toLowerCase().trim();
        if (keyLower.startsWith('import_') || keyLower.startsWith('__empty') || keyLower === 'import #') continue;
        cleaned[key] = row[key];
      }
      return cleaned;
    });

    const headers = Object.keys(cleanedRows[0] || {});
    if (VERBOSE_IMPORT_LOGS) {
      console.log('[CSV Parse] Headers detectados:', headers);
      console.log('[CSV Parse] Primera fila limpia:', cleanedRows[0]);
    }

    // Aplicar mapeo custom si viene del front
    const mapeoCustom = parseFile._mapeoCustom || {};
    let rowsFinales = cleanedRows;
    if (Object.keys(mapeoCustom).length > 0) {
      rowsFinales = cleanedRows.map(r => {
        const nueva = { ...r };
        Object.entries(mapeoCustom).forEach(([campoInterno, colArchivo]) => {
          if (colArchivo && r[colArchivo] !== undefined) nueva[campoInterno] = r[colArchivo];
        });
        return nueva;
      });
    }

    // Ya no rechazamos columnas desconocidas — simplemente las ignoramos
    return { headers, rows: rowsFinales };
  } catch (error) {
    throw new Error(`Error parseando archivo: ${error.message}`);
  }
}

function detectFormat(headers) {
  const lowerHeaders = headers.map(h => String(h).toLowerCase().trim());
  if (['codigo', 'fecha', 'unidades', 'importe'].every(c => lowerHeaders.includes(c))) return 'maxi_export';
  if (['article_id', 'date', 'qty', 'amount'].every(c => lowerHeaders.includes(c))) return 'basic';
  return null;
}

function normalizeDate(dateValue) {
  if (dateValue == null || dateValue === '') return null;
  if (dateValue instanceof Date && !isNaN(dateValue.getTime())) return dateValue.toISOString().slice(0, 10);
  if (typeof dateValue === 'number' && Number.isFinite(dateValue)) {
    const d = new Date(new Date(Date.UTC(1899, 11, 30)).getTime() + dateValue * 86400000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const s = String(dateValue).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    let yy = parseInt(m[3], 10);
    if (m[3].length === 2) yy = yy <= 69 ? 2000 + yy : 1900 + yy;
    const d = new Date(Date.UTC(yy, parseInt(m[2], 10) - 1, parseInt(m[1], 10)));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/);
  if (m) {
    let yy = parseInt(m[3], 10);
    if (m[3].length === 2) yy = yy <= 69 ? 2000 + yy : 1900 + yy;
    const d = new Date(Date.UTC(yy, parseInt(m[2], 10) - 1, parseInt(m[1], 10)));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (/^\d{4}[\/\.]/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
}

function normalizeRow(row, format = 'maxi_export', rowNumber) {
  const normalized = { date: null, article_id: null, qty: null, amount: null, article_name: null };
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
    normalized.date = normalizeDate(dateField);
    if (!normalized.date) throw new Error(`Fecha inválida o faltante: "${dateField}"`);
    const rawId = String(idField ?? '').trim();
    normalized.article_id = rawId === '' ? 0 : parseInt(rawId, 10);
    if (!Number.isFinite(normalized.article_id) || normalized.article_id < 0)
      throw new Error(`ID de artículo inválido: "${idField}"`);
    normalized.qty = parseFloat(String(qtyField ?? '').replace(',', '.'));
    if (!Number.isFinite(normalized.qty)) throw new Error(`Cantidad inválida: "${qtyField}"`);
    normalized.amount = parseFloat(String(amountField ?? '').replace(',', '.'));
    if (!Number.isFinite(normalized.amount)) throw new Error(`Importe inválido: "${amountField}"`);
    normalized.article_name = nameField != null ? String(nameField).trim() : null;
    return { ok: true, data: normalized };
  } catch (error) {
    return { ok: false, error: error.message, row: rowNumber, data: row };
  }
}

/* ══════════════════════════════════════════════════════════════
   CAMBIO 1: insertStagingItems — guarda branch_id en cada fila
══════════════════════════════════════════════════════════════ */
async function insertStagingItems(client, { importId, businessId, items, branchId = null }) {
  await client.query('DELETE FROM sales_csv_import_items WHERE import_id = $1', [importId]);

  const CHUNK = 1000;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk  = items.slice(i, i + CHUNK);
    const params = [];
    const rowsSql = chunk.map((r, idx) => {
      const base = idx * 8;  // ← era 7, ahora 8 (agrega branch_id)
      params.push(importId, businessId, r.day, r.article_id, r.qty, r.amount, r.article_name, branchId);
      return `($${base+1}, $${base+2}, $${base+3}::date, $${base+4}, $${base+5}, $${base+6}, $${base+7}, $${base+8})`;
    }).join(',');

    await client.query(`
      INSERT INTO sales_csv_import_items
        (import_id, business_id, day, article_id, qty, amount, article_name, branch_id)
      VALUES ${rowsSql}
      ON CONFLICT (import_id, day, article_id)
      DO UPDATE SET
        qty          = EXCLUDED.qty,
        amount       = EXCLUDED.amount,
        article_name = COALESCE(EXCLUDED.article_name, sales_csv_import_items.article_name),
        branch_id    = EXCLUDED.branch_id
    `, params);
  }
}

/* ══════════════════════════════════════════════════════════════
   CAMBIO 2: applyReplaceRange — filtra por branch_id
   - null (principal): DELETE/INSERT donde branch_id IS NULL
   - número (sucursal): DELETE/INSERT solo para esa branch_id
══════════════════════════════════════════════════════════════ */
async function applyReplaceRange(client, { businessId, from, to, importId, branchId = null }) {
  // DELETE: solo borra datos del mismo "origen" (principal o sucursal específica)
  if (branchId) {
    await client.query(`
      DELETE FROM sales_daily_items
      WHERE business_id = $1
        AND source = 'csv'
        AND day BETWEEN $2::date AND $3::date
        AND branch_id = $4
    `, [businessId, from, to, branchId]);
  } else {
    // Principal: solo borra filas sin sucursal asignada
    await client.query(`
      DELETE FROM sales_daily_items
      WHERE business_id = $1
        AND source = 'csv'
        AND day BETWEEN $2::date AND $3::date
        AND branch_id IS NULL
    `, [businessId, from, to]);
  }

  // INSERT: propaga branch_id desde staging
  const ins = await client.query(`
    INSERT INTO sales_daily_items
      (business_id, branch_id, day, article_id, qty, amount, article_name, source, created_at, updated_at)
    SELECT
      sci.business_id,
      sci.branch_id,      -- ← viene del staging, que lo heredó del import header
      sci.day,
      sci.article_id,
      sci.qty,
      sci.amount,
      sci.article_name,
      'csv',
      NOW(),
      NOW()
    FROM sales_csv_import_items sci
    WHERE sci.import_id = $1
  `, [importId]);

  return ins.rowCount || 0;
}

/* ══════════════════════════════════════════════════════════════
   CAMBIO 3: importFileToDatabase — pasa branchId a ambas funciones
══════════════════════════════════════════════════════════════ */
async function importFileToDatabase({ businessId, userId, filePath, originalName, fileType, branchId = null, mapeoCustom = {} }) {
  const client = await pool.connect();
  let importId = null;
  let txOpen   = false;

  try {
    await client.query('BEGIN');
    txOpen = true;

    const salesBusinessId = businessId;

    if (VERBOSE_IMPORT_LOGS) console.log(`[CSV Import] business=${salesBusinessId} branch=${branchId}`);

    // 1) Crear registro de importación con branch_id
    const { rows: [importRecord] } = await client.query(
      `INSERT INTO sales_csv_imports
         (business_id, user_id, filename, original_name, file_size, file_type, status, row_count, date_from, date_to, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'processing', 0, NULL, NULL, $7)
       RETURNING id`,
      [salesBusinessId, userId, path.basename(filePath), originalName, fs.statSync(filePath).size, fileType, branchId]
    );
    importId = importRecord.id;

    if (VERBOSE_IMPORT_LOGS) console.log(`[CSV] Import #${importId} creado (branch_id=${branchId})`);

    // 2) Parsear
    parseFile._mapeoCustom = mapeoCustom; // pasar mapeo al helper
    const { headers, rows } = await parseFile(filePath, fileType);
    if (rows.length === 0) throw new Error('El archivo no contiene filas de datos.');
    if (rows.length > MAX_IMPORT_ROWS)
      throw new Error(`El archivo excede el límite de ${MAX_IMPORT_ROWS} filas. Actual: ${rows.length}.`);

    // 3) Detectar formato — con mapeo puede haber cambiado los nombres
    const headersEfectivos = Object.keys(rows[0] || {});
    const format = detectFormat(headersEfectivos) || detectFormat(headers);
    if (!format)
      throw new Error(`Formato no reconocido. Columnas detectadas: ${headers.join(', ')}. Se esperan: fecha, codigo, unidades, importe`);

    // 4) Normalizar + agregar por day+article_id
    let failed = 0;
    const errors = [];
    let minDate = null, maxDate = null;
    const agg   = new Map();

    for (let i = 0; i < rows.length; i++) {
      const normalized = normalizeRow(rows[i], format, i + 1);
      if (!normalized.ok) {
        failed++;
        if (errors.length < 100) errors.push({ row: normalized.row, error: normalized.error, sample: normalized.data });
        continue;
      }
      const { date, article_id, qty, amount, article_name } = normalized.data;
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;
      const todayUTC = new Date().toISOString().slice(0, 10);
      if (date === todayUTC) continue;
      const key  = `${date}|${article_id}`;
      const prev = agg.get(key);
      if (!prev) {
        agg.set(key, { day: date, article_id, qty, amount, article_name });
      } else {
        prev.qty    += qty;
        prev.amount += amount;
        if (!prev.article_name && article_name) prev.article_name = article_name;
      }
    }

    if (!minDate || !maxDate) {
      await client.query(`
        UPDATE sales_csv_imports
        SET status='failed', row_count=$2, rows_failed=$3, error_log=$4::jsonb, processed_at=NOW()
        WHERE id=$1`,
        [importId, rows.length, failed, JSON.stringify(errors)]
      );
      await client.query('COMMIT');
      txOpen = false;
      try { fs.unlinkSync(filePath); } catch { }
      return {
        ok: false, import_id: importId, error: 'no_valid_rows',
        summary: { total_rows: rows.length, failed, has_errors: true, date_range: { from: null, to: null } },
        errors: errors.slice(0, 20),
      };
    }

    const items = Array.from(agg.values());

    // 5) Staging — con branch_id
    await insertStagingItems(client, { importId, businessId: salesBusinessId, items, branchId });

    // 6) Apply replace — con branch_id
    const appliedRows = await applyReplaceRange(client, {
      businessId: salesBusinessId,
      from: minDate,
      to:   maxDate,
      importId,
      branchId,
    });

    // 7) Rebuild aggregates
    await rebuildSalesDailyRange({ businessId: salesBusinessId, from: minDate, to: maxDate, client });

    // 8) Actualizar header del import
    await client.query(`
      UPDATE sales_csv_imports
      SET status=$2, row_count=$3, date_from=$4::date, date_to=$5::date,
          rows_inserted=$6, rows_updated=0, rows_failed=$7, error_log=$8::jsonb, processed_at=NOW()
      WHERE id=$1`,
      [importId, failed === rows.length ? 'failed' : 'completed', rows.length, minDate, maxDate, appliedRows, failed, JSON.stringify(errors)]
    );

    await client.query('COMMIT');
    txOpen = false;
    try { fs.unlinkSync(filePath); } catch { }

    if (VERBOSE_IMPORT_LOGS) console.log(`[CSV] Import #${importId} completado — ${appliedRows} filas (branch_id=${branchId})`);

    return {
      ok: true,
      mode: 'applied',
      import_id: importId,
      branch_id: branchId,
      summary: {
        total_rows: rows.length, valid_rows: items.length,
        inserted: appliedRows, failed, has_errors: failed > 0,
        date_range: { from: minDate, to: maxDate },
        applied_rows: appliedRows,
      },
      errors: errors.slice(0, 20),
    };

  } catch (error) {
    if (txOpen) { try { await client.query('ROLLBACK'); } catch { } }
    console.error('[CSV Import] Error fatal:', error);
    if (importId) {
      try {
        await pool.query(`
          UPDATE sales_csv_imports SET status='failed', error_log=$2::jsonb, processed_at=NOW() WHERE id=$1`,
          [importId, JSON.stringify([{ error: error.message }])]
        );
      } catch { }
    }
    try { fs.unlinkSync(filePath); } catch { }
    throw error;
  } finally {
    client.release();
  }
}

async function listImports(businessId, { limit = 20 } = {}) {
  const { rows } = await pool.query(`
    SELECT id, filename, original_name, file_size, file_type, status, row_count,
           date_from, date_to, rows_inserted, rows_updated, rows_failed, created_at, processed_at,
           branch_id,
           CASE WHEN error_log IS NOT NULL THEN jsonb_array_length(error_log) ELSE 0 END AS error_count
    FROM sales_csv_imports
    WHERE business_id = $1
    ORDER BY created_at DESC
    LIMIT $2`, [businessId, limit]);
  return rows;
}

async function getImportDetails(importId, businessId) {
  const { rows } = await pool.query(`
    SELECT id, business_id, user_id, filename, original_name, file_size, file_type,
           status, row_count, date_from, date_to, rows_inserted, rows_updated, rows_failed,
           error_log, created_at, processed_at, branch_id
    FROM sales_csv_imports
    WHERE id=$1 AND business_id=$2
    LIMIT 1`, [importId, businessId]);
  return rows[0] || null;
}

module.exports = { importFileToDatabase, listImports, getImportDetails, applyReplaceRange };