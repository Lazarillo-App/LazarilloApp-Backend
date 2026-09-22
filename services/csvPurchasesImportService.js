// services/csvPurchasesImportService.js
'use strict';

const pool = require('../config/db');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { generateBatchId } = require('./purchasesStore');
const { recalcularBonificaciones } = require('./bonificacionesService');
const { propagarCostoInsumo } = require('./costoRecetaService');
const { getModoCosteo, calcularPreciosPorModo, aplicarPreciosCosteo } = require('./precioCosteoInsumos');

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

async function parseFile(filePath, mapeoCustom = {}) {
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

  // Aplicar mapeo custom: renombrar columnas del archivo a nombres internos
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

  const headers = Object.keys(cleanedRows[0] || {});
  const headersEfectivos = Object.keys(rowsFinales[0] || {});
  const headersLower = headersEfectivos.map(h => String(h).toLowerCase().trim());

  // Validar columnas requeridas — con mapeo puede que ya estén
  const required = ['codigo', 'cantidad', 'importe', 'fecha'];
  const missing = required.filter(r => !headersLower.includes(r));
  if (missing.length) {
    throw new Error(
      `Columnas requeridas faltantes: ${missing.join(', ')}. ` +
      `Columnas detectadas: ${headers.join(', ')}.`
    );
  }

  return { headers, rows: rowsFinales };
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
    const fecha = normalizeDate(getCI(row, ['fecha', 'date']));
    if (!fecha) throw new Error(`Fecha inválida: "${getCI(row, ['fecha'])}"`);

    const codigoRaw = String(getCI(row, ['codigo', 'code']) ?? '').trim();
    const codigo = codigoRaw === '' ? null : parseInt(codigoRaw, 10);
    if (codigo == null || !Number.isFinite(codigo) || codigo < 0) {
      throw new Error(`Código inválido: "${codigoRaw}"`);
    }

    const cantidad = parseNum(getCI(row, ['cantidad', 'qty', 'quantity']));
    if (cantidad == null) throw new Error(`Cantidad inválida: "${getCI(row, ['cantidad'])}"`);

    const importe = parseNum(getCI(row, ['importe', 'amount', 'total']));
    if (importe == null) throw new Error(`Importe inválido: "${getCI(row, ['importe'])}"`);

    const nombre = getCI(row, ['nombre', 'name']) != null ? String(getCI(row, ['nombre', 'name'])).trim() : null;
    const proveedor = getCI(row, ['proveedor', 'supplier']) != null ? String(getCI(row, ['proveedor', 'supplier'])).trim() : null;
    const comprob = getCI(row, ['comprob', 'comprobante', 'factura', 'invoice']) != null
      ? String(getCI(row, ['comprob', 'comprobante', 'factura', 'invoice'])).trim()
      : null;
    const pProm = parseNum(getCI(row, ['p_prom', 'precio', 'price', 'precio_prom']));
    const medida = getCI(row, ['medida', 'unidad', 'unit']) != null ? String(getCI(row, ['medida', 'unidad', 'unit'])).trim() : null;
    const codProRaw = getCI(row, ['cod_pro', 'cod_proveedor']);
    const codPro = codProRaw != null && String(codProRaw).trim() !== ''
      ? parseInt(String(codProRaw).trim(), 10)
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
 * Cada negocio es dueño de sus propias compras:
 *   dataBizId  = businessId que llega → donde se guardan las compras
 *   credsBizId = negocio principal de la org → donde están los insumos (lista compartida)
 *
 * Estrategia:
 * - Cada fila del CSV = un purchase_item (una línea de factura)
 * - Se agrupa por (comprob, codigo) para acumular si hay duplicados
 * - Para el rango de fechas del archivo: DELETE los items con source='csv' del dataBizId
 *   y luego INSERT los nuevos → el último archivo es la fuente de verdad
 * - Se vincula el insumo_id buscando por codigo_maxi en la tabla insumos (del principal)
 * - Nunca se importa el día actual
 */

async function importPurchasesToDatabase({ businessId, userId, filePath, originalName, fileType, branchId = null, mapeoCustom = {} }) {
  const client = await pool.connect();
  let importId = null;
  let txOpen = false;

  try {
    // ── dataBizId: donde se guardan las compras (el negocio activo) ──
    const dataBizId = Number(businessId);

    // ── credsBizId: donde están los insumos (el principal de la org) ──
    // La lista de insumos es compartida y vive en el negocio principal.
    const { rows: bizRows } = await pool.query(
      `SELECT created_from, organization_id FROM app_businesses WHERE id = $1`, [dataBizId]
    );
    const biz = bizRows[0] || {};
    let credsBizId = dataBizId; // default: mismo negocio (si es independiente)
    if (biz.created_from === 'from_group' && biz.organization_id) {
      const { rows: rootRows } = await pool.query(
        `SELECT id FROM app_businesses
          WHERE organization_id = $1
            AND (created_from IS NULL OR created_from = 'manual' OR created_from = 'onboarding')
          ORDER BY id ASC LIMIT 1`,
        [biz.organization_id]
      );
      if (rootRows[0]?.id) credsBizId = Number(rootRows[0].id);
    }

    console.log(`[CSV Purchases Import] dataBizId=${dataBizId} credsBizId=${credsBizId}`);

    // Generar batch_id único para este lote de importación
    const batchId = generateBatchId();
    console.log(`[CSV Purchases Import] batch_id=${batchId}`);

    await client.query('BEGIN');
    txOpen = true;

    // Registro de importación — se guarda con el negocio activo (dataBizId)
    const { rows: [rec] } = await client.query(
      `INSERT INTO purchases_csv_imports
         (business_id, user_id, filename, original_name, file_size, file_type, status)
       VALUES ($1,$2,$3,$4,$5,$6,'processing')
       RETURNING id`,
      [dataBizId, userId, path.basename(filePath), originalName, fs.statSync(filePath).size, fileType]
    );
    importId = rec.id;

    // Parsear
    const { rows } = await parseFile(filePath, mapeoCustom);

    // Normalizar
    const errors = [];
    let failed = 0;
    let minDate = null;
    let maxDate = null;
    const items = [];
    const todayUTC = new Date().toISOString().slice(0, 10);

    for (let i = 0; i < rows.length; i++) {
      const norm = normalizeRow(rows[i], i);
      if (!norm.ok) {
        failed++;
        if (errors.length < 100) errors.push({ row: norm.row, error: norm.error });
        continue;
      }
      const { fecha, codigo, cantidad, importe, nombre, proveedor, comprob, p_prom, medida, cod_pro } = norm.data;

      if (fecha === todayUTC) continue;

      if (!minDate || fecha < minDate) minDate = fecha;
      if (!maxDate || fecha > maxDate) maxDate = fecha;

      items.push({ fecha, codigo, cantidad, importe, nombre, proveedor, comprob, p_prom, medida, cod_pro: Number.isFinite(cod_pro) ? cod_pro : null });
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

    // ── Insumos: buscar en credsBizId (lista compartida del principal) ──
    const { rows: insumoRows } = await client.query(
      `SELECT id, codigo_maxi::bigint AS codigo_maxi FROM insumos
       WHERE business_id = $1 AND codigo_maxi IS NOT NULL AND codigo_maxi ~ '^[0-9]+$'`,
      [credsBizId]
    );
    const insumoMap = new Map();
    for (const r of insumoRows) {
      if (r.codigo_maxi != null) insumoMap.set(Number(r.codigo_maxi), Number(r.id));
    }
    console.log(`[CSV Purchases Import] insumoMap: ${insumoMap.size} insumos del biz ${credsBizId}`);

    // Verificar columna source
    const { rows: colCheck } = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'purchase_items' AND column_name = 'source'
    `);
    const hasSource = colCheck.length > 0;

    // ── DELETE del rango — solo del negocio activo (dataBizId) ──
    if (hasSource) {
      await client.query(
        `DELETE FROM purchase_items
        WHERE business_id = $1 
          AND source = 'csv' 
          AND fecha BETWEEN $2::date AND $3::date
          AND purchase_id IN (
        SELECT id FROM purchases 
        WHERE business_id = $1 
         AND source = 'csv'
         AND COALESCE(branch_id, -1) = COALESCE($4, -1)
        )`,
        [dataBizId, minDate, maxDate, branchId]
      );
    } else {
      await client.query(
        `DELETE FROM purchase_items
         WHERE business_id = $1 
         AND fecha BETWEEN $2::date AND $3::date`,
        [dataBizId, minDate, maxDate]
      );
    }

    const { rows: colCheck2 } = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'purchases' AND column_name = 'source'
    `);
    const hasPurchaseSource = colCheck2.length > 0;

    if (hasPurchaseSource) {
      await client.query(
        `DELETE FROM purchases
        WHERE business_id = $1 
          AND source = 'csv' 
          AND fecha BETWEEN $2::date AND $3::date
          AND COALESCE(branch_id, -1) = COALESCE($4, -1)`,
        [dataBizId, minDate, maxDate, branchId]
      );
    }

    // ── Proveedores: upsert en el PRINCIPAL de la org (credsBizId) ──
    // Modelo org-wide: los proveedores viven en el principal, igual que los insumos.
    // Se pueblan desde el CSV (cod_pro + proveedor) para no dejar compras huérfanas.
    const provMap = new Map(); // cod_pro → nombre (dedup por lote)
    for (const item of items) {
      if (Number.isFinite(item.cod_pro) && item.cod_pro > 0) {
        const nom = (item.proveedor || '').trim();
        // Preferimos un nombre no vacío si el mismo cod_pro aparece con y sin nombre
        if (!provMap.has(item.cod_pro) || (nom && !provMap.get(item.cod_pro))) {
          provMap.set(item.cod_pro, nom || null);
        }
      }
    }
    for (const [codPro, nom] of provMap) {
      await client.query(
        `INSERT INTO suppliers (id, business_id, nombre, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (business_id, id) DO UPDATE SET
           nombre     = COALESCE(NULLIF(EXCLUDED.nombre, ''), suppliers.nombre),
           updated_at = NOW()`,
        [codPro, credsBizId, nom]
      );
    }

    // ── INSERT — todos los registros con business_id = dataBizId ──
    const purchaseMap = new Map();
    const CHUNK = 500;
    let insertedCount = 0;

    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);

      for (const item of chunk) {
        const comprobKey = item.comprob ?? `CSV-${item.fecha}-${item.codigo}`;

        if (!purchaseMap.has(comprobKey)) {
          const { rows: [ph] } = await client.query(
            `INSERT INTO purchases
            (business_id, factura_key, proveedor_id, fecha, neto_total, iva_total,
              imp_int_total, total, source, batch_id, branch_id, synced_at, updated_at)
             VALUES ($1,$2,$3,$4::date,0,0,0,0,'csv',$5,$6,NOW(),NOW())
            ON CONFLICT (business_id, factura_key, COALESCE(branch_id, -1)) DO UPDATE SET
              batch_id   = EXCLUDED.batch_id,
              updated_at = NOW()
          RETURNING id`,
            [dataBizId, comprobKey, (Number.isFinite(item.cod_pro) ? item.cod_pro : null), item.fecha, batchId, branchId]
          );
          purchaseMap.set(comprobKey, ph.id);
        }

        const purchaseId = purchaseMap.get(comprobKey);
        const insumoId = insumoMap.get(item.codigo) ?? null;

        if (hasSource) {
          await client.query(
            `INSERT INTO purchase_items
               (purchase_id, business_id, insumo_id, fecha, cantidad, precio, precio_total,
                source, referencia)
             VALUES ($1,$2,$3,$4::date,$5,$6,$7,'csv',$8)`,
            [purchaseId, dataBizId, insumoId, item.fecha,
              item.cantidad, item.p_prom ?? 0, item.importe, item.nombre ?? null]
          );
        } else {
          await client.query(
            `INSERT INTO purchase_items
               (purchase_id, business_id, insumo_id, fecha, cantidad, precio, precio_total,
                referencia)
             VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8)`,
            [purchaseId, dataBizId, insumoId, item.fecha,
              item.cantidad, item.p_prom ?? 0, item.importe, item.nombre ?? null]
          );
        }
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

    // Insumos con compras en este archivo (dataBizId = donde vive la compra).
    const { rows: tocadosRows } = await client.query(
      `SELECT DISTINCT pi.insumo_id
         FROM purchase_items pi
        WHERE pi.business_id = $1
          AND pi.insumo_id IS NOT NULL
          AND pi.fecha BETWEEN $2::date AND $3::date`,
      [dataBizId, minDate, maxDate]
    );
    const insumoIdsTocados = tocadosRows.map(r => r.insumo_id).filter(Boolean);

    // ── Actualizar precio_ref en insumos según el modo de costeo elegido en
    // Configuración > Insumos (última compra / promedio 30 días / precio fijo
    // del sistema) — antes esto siempre usaba "última compra" sin mirar esa
    // configuración. El modo vive en el negocio principal (credsBizId, donde
    // viven los insumos); las compras en sí pueden estar en dataBizId (un
    // subnegocio con las mismas credenciales de Maxi).
    const modoCosteo = await getModoCosteo(credsBizId, client);
    const preciosPorModo = await calcularPreciosPorModo(client, dataBizId, insumoIdsTocados, modoCosteo);
    const idsActualizadosPorCompra = preciosPorModo
      ? await aplicarPreciosCosteo(client, credsBizId, preciosPorModo)
      : [];
    // Mismo shape que antes ({ id }) — lo consume propagarCambiosImportEnBackground.
    const insumosActualizadosRows = idsActualizadosPorCompra.map((id) => ({ id }));
    const preciosActualizados = insumosActualizadosRows.length;
    if (preciosActualizados > 0) {
      console.log(`[CSV Purchases Import] precio_ref actualizado en ${preciosActualizados} insumos (modo: ${modoCosteo})`);
    }

    await client.query('COMMIT');
    txOpen = false;

    try { fs.unlinkSync(filePath); } catch { }

    console.log(`[CSV Purchases Import] OK — dataBizId=${dataBizId} inserted=${insertedCount} range=${minDate}→${maxDate} batch=${batchId}`);

    // ── Recalcular costos en 2° plano (no bloquea la respuesta) ──
    // Antes esto corría acá mismo, adentro de la MISMA transacción del import, antes
    // de responder — con un archivo que tocara varias docenas de insumos (cada uno
    // propagando en cascada a sus recetas, y de ahí a elaborados anidados), eran
    // cientos de consultas secuenciales y la pantalla de carga quedaba esperando
    // minutos. Ahora las compras quedan guardadas y confirmadas al toque; el costo
    // de las recetas se pone al día unos segundos después, solo.
    propagarCambiosImportEnBackground(dataBizId, insumosActualizadosRows, insumoIdsTocados)
      .catch(e => console.error('[CSV Purchases Import] error en recálculo de 2° plano:', e));

    return {
      ok: true,
      import_id: importId,
      batch_id: batchId,
      summary: {
        total_rows: rows.length,
        valid_rows: items.length,
        inserted: insertedCount,
        failed,
        has_errors: failed > 0,
        date_range: { from: minDate, to: maxDate },
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

// ── Recálculo posterior al import, fuera de la transacción principal ──
// Corre con `pool` (conexiones propias, no la del import ya cerrada/commiteada).
// Best-effort: si algo falla acá, las compras ya quedaron guardadas igual — mismo
// criterio de tolerancia a errores que tenía este bloque cuando vivía adentro del
// import (nunca abortaba el import por esto).
async function propagarCambiosImportEnBackground(dataBizId, insumosActualizadosRows, insumoIdsTocados) {
  const t0 = Date.now();

  if (insumosActualizadosRows.length) {
    for (const row of insumosActualizadosRows) {
      try {
        await propagarCostoInsumo(row.id, dataBizId, pool);
      } catch (e) {
        console.error(`[CSV Purchases Import 2°plano] propagarCostoInsumo error insumo ${row.id}:`, e.message);
      }
    }
  }

  if (insumoIdsTocados.length) {
    try {
      await recalcularBonificaciones(dataBizId, insumoIdsTocados, pool);
    } catch (e) {
      console.error('[CSV Purchases Import 2°plano] recalcularBonificaciones error:', e.message);
    }
  }

  console.log(`[CSV Purchases Import 2°plano] listo en ${Date.now() - t0}ms — ${insumosActualizadosRows.length} insumos propagados`);
}

module.exports = { importPurchasesToDatabase };