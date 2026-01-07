// services/csvSalesImportService.js
const pool = require('../config/db');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { VERBOSE_IMPORT_LOGS, MAX_IMPORT_ROWS } = require('../config/features');

/**
 * Parsea archivo Excel (XLS/XLSX) o CSV
 */
async function parseFile(filePath, fileType) {
    try {
        if (fileType === 'csv') {
            // Para CSV, usar XLSX que también lo soporta
            const workbook = XLSX.readFile(filePath, { type: 'file' });
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(worksheet, {
                raw: false,  // Mantener fechas como strings
                dateNF: 'yyyy-mm-dd'
            });

            return {
                headers: Object.keys(data[0] || {}),
                rows: data
            };
        } else {
            // XLS/XLSX
            const workbook = XLSX.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(worksheet, {
                raw: false,
                dateNF: 'yyyy-mm-dd'
            });

            return {
                headers: Object.keys(data[0] || {}),
                rows: data
            };
        }
    } catch (error) {
        throw new Error(`Error parseando archivo: ${error.message}`);
    }
}

/**
 * Detecta el formato del archivo basándose en las columnas
 */
function detectFormat(headers) {
    const lowerHeaders = headers.map(h => h.toLowerCase().trim());

    // Formato Maxi Export (tu archivo actual)
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
 * Normaliza una fecha de Excel
 */
function normalizeDate(dateValue) {
    if (!dateValue) return null;

    // Si ya es string en formato YYYY-MM-DD
    if (typeof dateValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
        return dateValue;
    }

    // Si es número de Excel (serial date)
    if (typeof dateValue === 'number') {
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        const date = new Date(excelEpoch.getTime() + dateValue * 86400000);
        return date.toISOString().split('T')[0];
    }

    // Si es Date object
    if (dateValue instanceof Date) {
        return dateValue.toISOString().split('T')[0];
    }

    // Intentar parsear como string
    try {
        const date = new Date(dateValue);
        if (!isNaN(date.getTime())) {
            return date.toISOString().split('T')[0];
        }
    } catch { }

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
        article_name: null
    };

    try {
        // Mapeo según formato
        let dateField, idField, qtyField, amountField, nameField;

        if (format === 'maxi_export') {
            dateField = row.fecha || row.Fecha;
            idField = row.codigo || row.Codigo;
            qtyField = row.unidades || row.Unidades;
            amountField = row.importe || row.Importe;
            nameField = row.nombre || row.Nombre;
        } else {
            dateField = row.date || row.fecha;
            idField = row.article_id || row.codigo;
            qtyField = row.qty || row.unidades;
            amountField = row.amount || row.importe;
            nameField = row.article_name || row.nombre;
        }

        // Fecha (obligatorio)
        normalized.date = normalizeDate(dateField);
        if (!normalized.date) {
            throw new Error(`Fecha inválida o faltante: "${dateField}"`);
        }

        // Article ID (obligatorio)
        normalized.article_id = parseInt(idField);
        if (!Number.isFinite(normalized.article_id) || normalized.article_id < 0) {
            throw new Error(`ID de artículo inválido: "${idField}"`);
        }

        // Cantidad (obligatorio)
        normalized.qty = parseFloat(String(qtyField).replace(',', '.'));
        if (!Number.isFinite(normalized.qty)) {
            throw new Error(`Cantidad inválida: "${qtyField}"`);
        }

        // Importe (obligatorio)
        normalized.amount = parseFloat(String(amountField).replace(',', '.'));
        if (!Number.isFinite(normalized.amount)) {
            throw new Error(`Importe inválido: "${amountField}"`);
        }

        // Nombre (opcional, para referencia)
        normalized.article_name = nameField ? String(nameField).trim() : null;

        return { ok: true, data: normalized };
    } catch (error) {
        return {
            ok: false,
            error: error.message,
            row: rowNumber,
            data: row
        };
    }
}

/**
 * Importa archivo a la base de datos
 */
async function importFileToDatabase({
    businessId,
    userId,
    filePath,
    originalName,
    fileType
}) {
    const client = await pool.connect();
    let importId = null;

    try {
        // 1. Crear registro de importación
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

        // 2. Parsear archivo
        const { headers, rows } = await parseFile(filePath, fileType);

        if (VERBOSE_IMPORT_LOGS) {
            console.log(`[CSV Import] Parseado: ${rows.length} filas, columnas:`, headers);
        }

        // Validar límite de filas
        if (rows.length > MAX_IMPORT_ROWS) {
            throw new Error(
                `El archivo excede el límite de ${MAX_IMPORT_ROWS} filas. ` +
                `Actual: ${rows.length}. Dividí el archivo en partes más pequeñas.`
            );
        }

        // 3. Detectar formato
        const format = detectFormat(headers);
        if (!format) {
            throw new Error(
                `Formato de archivo no reconocido. Columnas encontradas: ${headers.join(', ')}. ` +
                `Columnas esperadas: fecha, codigo, unidades, importe`
            );
        }

        if (VERBOSE_IMPORT_LOGS) {
            console.log(`[CSV Import] Formato detectado: ${format}`);
        }

        // 4. Procesar filas
        let inserted = 0;
        let updated = 0;
        let failed = 0;
        const errors = [];
        let minDate = null;
        let maxDate = null;

        // NO usar BEGIN aquí - cada INSERT será autocommit
        for (let i = 0; i < rows.length; i++) {
            const normalized = normalizeRow(rows[i], format, i + 1);

            if (!normalized.ok) {
                failed++;
                if (errors.length < 100) {
                    errors.push({
                        row: normalized.row,
                        error: normalized.error,
                        sample: normalized.data
                    });
                }
                continue;
            }

            const { date, article_id, qty, amount, article_name } = normalized.data;

            // Trackear rango de fechas
            if (!minDate || date < minDate) minDate = date;
            if (!maxDate || date > maxDate) maxDate = date;

            // 5. Insertar/actualizar en sales_daily_items (sin transacción)
            try {
                const result = await client.query(`
          INSERT INTO sales_daily_items 
            (business_id, day, article_id, qty, amount, article_name, source, created_at, updated_at)
          VALUES ($1, $2::date, $3, $4, $5, $6, 'csv', NOW(), NOW())
          ON CONFLICT (business_id, day, article_id, source)
          DO UPDATE SET
            qty = sales_daily_items.qty + EXCLUDED.qty,
            amount = sales_daily_items.amount + EXCLUDED.amount,
            article_name = COALESCE(EXCLUDED.article_name, sales_daily_items.article_name),
            updated_at = NOW()
        `, [businessId, date, article_id, qty, amount, article_name]);

                inserted++;
            } catch (dbError) {
                console.error(`[CSV Import] Error en fila ${i + 1}:`, dbError.message);
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

        // 6. Actualizar registro de importación (sin transacción)
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

        // 7. Limpiar archivo temporal
        try {
            fs.unlinkSync(filePath);
        } catch (unlinkErr) {
            console.warn('[CSV Import] No se pudo eliminar archivo temporal:', unlinkErr.message);
        }

        if (VERBOSE_IMPORT_LOGS) {
            console.log(`[CSV Import] Completado: ${inserted} insertadas, ${failed} fallidas`);
        }

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
            errors: errors.slice(0, 20) // Devolver solo primeros 20 errores
        };

    } catch (error) {
        await client.query('ROLLBACK');

        console.error('[CSV Import] Error fatal:', error);

        // Marcar importación como fallida
        if (importId) {
            try {
                await client.query(`
          UPDATE sales_csv_imports
          SET 
            status = 'failed', 
            error_log = $2::jsonb, 
            processed_at = NOW()
          WHERE id = $1
        `, [importId, JSON.stringify([{ error: error.message }])]);
            } catch { }
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
        WHEN error_log IS NOT NULL 
        THEN jsonb_array_length(error_log)
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
 * Obtiene detalles de una importación específica
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

    if (!rows.length) return null;

    return rows[0];
}

module.exports = {
    importFileToDatabase,
    listImports,
    getImportDetails
};