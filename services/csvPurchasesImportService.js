// services/csvPurchasesImportService.js
'use strict';

const pool = require('../config/db');
const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

/**
 * Columnas esperadas del informe de MaxiRest:
 * RUBRO | CODIGO | NOMBRE | MEDIDA | P_PROM | CANTIDAD | IMPORTE | COD_PRO | PROVEEDOR | COMPROB | FECHA
 */

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

async function parseFile(filePath) {
  const workbook = XLSX.readFile(filePath, { type: 'file', cellDates: true, raw: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('El archivo no contiene hojas');

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: true, defval: null });

  const cleanedRows = rows.map(row => {
    const cleaned = {};
    for (const key of Object.keys(row)) {
      const kl = String(key).toLowerCase().trim();
      if (kl.startsWith('__empty') || kl.startsWith('import_')) continue;
      cleaned[key] = row[key];
    }
    return cleaned;
  }).filter(r => Object.values(r).some(v => v != null && v !== ''));

  if (!cleanedRows.length) throw new Error('El archivo no contiene filas de datos');

  const headers = Object.keys(cleanedRows[0] || {});

  // Validar que tenga al menos las columnas mínimas
  const required = ['codigo', 'cantidad', 'importe', 'fecha'];
  const headersLower = headers.map(h => String(h).toLowerCase().trim());
  const missing = required.filter(r => !headersLower.includes(r));
  if (missing.length) {
    throw new Error(
      `Columnas faltantes: ${missing.join(', ')}. ` +
      `Asegurate de exportar el informe de compras correcto desde MaxiRest (necesita: CODIGO, CANTIDAD, IMPORTE, FECHA).`
    );
  }

  return { headers, rows: cleanedRows };
}

function normalizeDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(new Date(Date.UTC(1899, 11, 30)).getTime() + v * 86400000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    let [, dd, mm, yy] = m;
    dd = parseInt(dd); mm = parseInt(mm); yy = parseInt(yy);
    if (String(m[3]).length === 2) yy = yy <= 69 ? 2000 + yy : 1900 + yy;
    const d = new Date(Date.UTC(yy, mm - 1, dd));
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/);
  if (m) {
    let [, dd, mm, yy] = m;
    dd = parseInt(dd); mm = parseInt(mm); yy = parseInt(yy);
    if (String(m[3]).length === 2) yy = yy <= 69 ? 2000 + yy : 1900 + yy;
    const d = new Date(Date.UTC(yy, mm - 1, dd));
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function parseNum(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function normalizeRow(row, idx) {
  try {
    const fecha    = normalizeDate(getCI(row, ['fecha', 'date']));
    if (!fecha) throw new Error(`Fecha inválida: "${getCI(row, ['fecha'])}"`);

    const codigoRaw = String(getCI(row, ['codigo', 'code']) ?? '').trim();
    const codigo    = codigoRaw === '' ? null : parseInt(codigoRaw, 10);
    if (codigo == null || !Number.isFinite(codigo) || codigo < 0) {
      throw new Error(`Código inválido: "${codigoRaw}"`);
    }

    const cantidad = parseNum(getCI(row, ['cantidad', 'qty', 'quantity']));
    if (cantidad == null) throw new Error(`Cantidad inválida: "${getCI(row, ['cantidad'])}"`);

    const importe = parseNum(getCI(row, ['importe', 'amount', 'total']));
    if (importe == null) throw new Error(`Importe inválido: "${getCI(row, ['importe'])}"`);

    const nombre    = getCI(row, ['nombre', 'name'])    != null ? String(getCI(row, ['nombre', 'name'])).trim()    : null;
    const proveedor = getCI(row, ['proveedor', 'supplier']) != null ? String(getCI(row, ['proveedor', 'supplier'])).trim() : null;
    const comprob   = getCI(row, ['comprob', 'comprobante', 'factura', 'invoice']) != null
      ? String(getCI(row, ['comprob', 'comprobante', 'factura', 'invoice'])).trim()
      : null;
    const pProm     = parseNum(getCI(row, ['p_prom', 'precio', 'price', 'precio_prom']));
    const medida    = getCI(row, ['medida', 'unidad', 'unit']) != null ? String(getCI(row, ['medida', 'unidad', 'unit'])).trim() : null;
    const codPro    = getCI(row, ['cod_pro', 'cod_proveedor']) != null
      ? parseInt(String(getCI(row, ['cod_pro', 'cod_proveedor'])), 10)
      : null;

    return {
      ok: true,
      data: { fecha, codigo, cantidad, importe, nombre, proveedor, comprob, p_prom: pProm, medida, cod_pro: Number.isFinite(codPro) ? codPro : null },
    };
  } catch (e) {
    return { ok: false, error: e.message, row: idx + 1, data: row };
  }
}

/**
 * Importa compras CSV a purchase_items.
 *
 * Estrategia:
 * - Cada fila del CSV = un purchase_item (una línea de factura)
 * - Se agrupa por (comprob, codigo) para acumular si hay duplicados
 * - Para el rango de fechas del archivo: DELETE todos los items con source='csv'
 *   y luego INSERT los nuevos → el último archivo es la fuente de verdad
 * - Se vincula el insumo_id buscando por codigo_maxi en la tabla insumos
 * - Nunca se importa el día actual
 */
async function importPurchasesToDatabase({ businessId, userId, filePath, originalName, fileType }) {
  const client = await pool.connect();
  let importId  = null;
  let txOpen    = false;

  try {
    // Resolver al negocio principal (compras = recurso global)
    const { rows: bizRows } = await pool.query(
      `SELECT created_from, organization_id FROM app_businesses WHERE id = $1`, [businessId]
    );
    const biz = bizRows[0] || {};
    let salesBizId = Number(businessId);
    if (biz.created_from === 'from_group' && biz.organization_id) {
      const { rows: rootRows } = await pool.query(
        `SELECT id FROM app_businesses
          WHERE organization_id = $1
            AND (created_from IS NULL OR created_from = 'manual' OR created_from = 'onboarding')
          ORDER BY id ASC LIMIT 1`,
        [biz.organization_id]
      );
      if (rootRows[0]?.id) salesBizId = Number(rootRows[0].id);
    }

    await client.query('BEGIN');
    txOpen = true;

    // Registro de importación
    const { rows: [rec] } = await client.query(
      `INSERT INTO purchases_csv_imports
         (business_id, user_id, filename, original_name, file_size, file_type, status)
       VALUES ($1,$2,$3,$4,$5,$6,'processing')
       RETURNING id`,
      [salesBizId, userId, path.basename(filePath), originalName, fs.statSync(filePath).size, fileType]
    );
    importId = rec.id;

    // Parsear
    const { rows } = await parseFile(filePath);

    // Normalizar
    const errors  = [];
    let   failed  = 0;
    let   minDate = null;
    let   maxDate = null;

    // Map key: `${fecha}|${codigo}|${comprob}` → acumula cantidad e importe
    const agg = new Map();

    const todayUTC = new Date().toISOString().slice(0, 10);

    for (let i = 0; i < rows.length; i++) {
      const norm = normalizeRow(rows[i], i);
      if (!norm.ok) {
        failed++;
        if (errors.length < 100) errors.push({ row: norm.row, error: norm.error });
        continue;
      }
      const { fecha, codigo, cantidad, importe, nombre, proveedor, comprob, p_prom, medida, cod_pro } = norm.data;

      // Nunca importar el día actual
      if (fecha === todayUTC) continue;

      if (!minDate || fecha < minDate) minDate = fecha;
      if (!maxDate || fecha > maxDate) maxDate = fecha;

      // Clave única por fecha + código + comprobante (cada factura es una línea)
      const key = `${fecha}|${codigo}|${comprob ?? ''}`;
      if (!agg.has(key)) {
        agg.set(key, { fecha, codigo, cantidad, importe, nombre, proveedor, comprob, p_prom, medida, cod_pro });
      } else {
        const prev = agg.get(key);
        prev.cantidad += cantidad;
        prev.importe  += importe;
        if (!prev.nombre    && nombre)    prev.nombre    = nombre;
        if (!prev.proveedor && proveedor) prev.proveedor = proveedor;
      }
    }

    if (!minDate || !maxDate) {
      await client.query(
        `UPDATE purchases_csv_imports SET status='failed', row_count=$2, rows_failed=$3,
         error_log=$4::jsonb, processed_at=NOW() WHERE id=$1`,
        [importId, rows.length, failed, JSON.stringify(errors)]
      );
      await client.query('COMMIT');
      txOpen = false;
      try { fs.unlinkSync(filePath); } catch { }
      return {
        ok: false, import_id: importId, error: 'no_valid_rows',
        summary: { total_rows: rows.length, failed, date_range: { from: null, to: null } }, errors: errors.slice(0, 20),
      };
    }

    const items = Array.from(agg.values());

    // Construir mapa codigo_maxi → insumo_id
    const { rows: insumoRows } = await client.query(
      `SELECT id, codigo_maxi::bigint AS codigo_maxi FROM insumos
       WHERE business_id = $1 AND codigo_maxi IS NOT NULL AND codigo_maxi ~ '^[0-9]+$'`,
      [salesBizId]
    );
    const insumoMap = new Map();
    for (const r of insumoRows) {
      if (r.codigo_maxi != null) insumoMap.set(Number(r.codigo_maxi), Number(r.id));
    }

    // DELETE del rango completo para este negocio (source='csv')
    await client.query(
      `DELETE FROM purchase_items
       WHERE business_id = $1 AND source = 'csv' AND fecha BETWEEN $2::date AND $3::date`,
      [salesBizId, minDate, maxDate]
    );

    // También limpiar purchases huérfanos de CSV en ese rango
    await client.query(
      `DELETE FROM purchases
       WHERE business_id = $1 AND source = 'csv' AND fecha BETWEEN $2::date AND $3::date`,
      [salesBizId, minDate, maxDate]
    );

    // INSERT de los nuevos items — cada comprobante único → 1 purchase header
    // Agrupar por comprob para crear los headers
    const purchaseMap = new Map(); // comprob → purchase_id

    const CHUNK = 500;
    let insertedCount = 0;

    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);

      for (const item of chunk) {
        const comprobKey = item.comprob ?? `CSV-${item.fecha}-${item.codigo}`;

        // Upsert del header de compra
        if (!purchaseMap.has(comprobKey)) {
          const { rows: [ph] } = await client.query(
            `INSERT INTO purchases
               (business_id, factura_key, proveedor_id, fecha, neto_total, iva_total,
                imp_int_total, total, source, synced_at, updated_at)
             VALUES ($1,$2,$3,$4::date,0,0,0,0,'csv',NOW(),NOW())
             ON CONFLICT (business_id, factura_key) DO UPDATE SET
               updated_at = NOW()
             RETURNING id`,
            [salesBizId, comprobKey,
             // Si tenemos cod_pro intentamos vincular al supplier
             item.cod_pro || null,
             item.fecha]
          );
          purchaseMap.set(comprobKey, ph.id);
        }

        const purchaseId = purchaseMap.get(comprobKey);
        const insumoId   = insumoMap.get(item.codigo) ?? null;

        await client.query(
          `INSERT INTO purchase_items
             (purchase_id, business_id, insumo_id, fecha, cantidad, precio, precio_total,
              source, referencia, created_at)
           VALUES ($1,$2,$3,$4::date,$5,$6,$7,'csv',$8,NOW())`,
          [purchaseId, salesBizId, insumoId, item.fecha,
           item.cantidad,
           item.p_prom ?? 0,
           item.importe,
           item.nombre ?? null]
        );
        insertedCount++;
      }
    }

    await client.query(
      `UPDATE purchases_csv_imports SET
         status = $2, row_count = $3, date_from = $4::date, date_to = $5::date,
         rows_inserted = $6, rows_failed = $7, error_log = $8::jsonb, processed_at = NOW()
       WHERE id = $1`,
      [importId,
       failed === rows.length ? 'failed' : 'completed',
       rows.length, minDate, maxDate,
       insertedCount, failed, JSON.stringify(errors)]
    );

    await client.query('COMMIT');
    txOpen = false;

    try { fs.unlinkSync(filePath); } catch { }

    return {
      ok: true,
      import_id: importId,
      summary: {
        total_rows:  rows.length,
        valid_rows:  items.length,
        inserted:    insertedCount,
        failed,
        has_errors:  failed > 0,
        date_range:  { from: minDate, to: maxDate },
      },
      errors: errors.slice(0, 20),
    };

  } catch (error) {
    if (txOpen) { try { await client.query('ROLLBACK'); } catch { } }
    console.error('[CSV Purchases Import] Error fatal:', error);

    if (importId) {
      try {
        await pool.query(
          `UPDATE purchases_csv_imports SET status='failed', error_log=$2::jsonb, processed_at=NOW() WHERE id=$1`,
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

module.exports = { importPurchasesToDatabase };