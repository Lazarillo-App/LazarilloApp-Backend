// services/csvArticulosImportPairedService.js
// Importación combinada: rubros + subrubros + artículos en una sola operación.
// Hace el cruce automático COD_RUA / COD_SUA → nombre de rubro / subrubro.
//
// La sync con MaxiRest es estrictamente aditiva (ON CONFLICT DO NOTHING).
// Esta importación manual SÍ pisa nombres/categorías porque viene de un upload
// explícito del usuario — es la forma de corregir datos.
'use strict';

const pool = require('../config/db');
const XLSX = require('xlsx');
const fs = require('fs');

// ── Helpers ──────────────────────────────────────────────────────────────

function getCI(obj, candidates) {
  if (!obj || typeof obj !== 'object') return undefined;
  const map = new Map();
  for (const k of Object.keys(obj)) map.set(String(k).trim().toLowerCase(), k);
  for (const c of candidates) {
    const real = map.get(String(c).trim().toLowerCase());
    if (real != null && obj[real] != null && obj[real] !== '') return obj[real];
  }
  return undefined;
}

function cleanStr(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  return s || null;
}

function safeInt(v) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Un CSV puede venir en UTF-8 (lo normal hoy) o en la codificación de Windows (Excel viejo). XLSX
// asume la de Windows y rompía los acentos de un UTF-8 ("Fainá" → "FainÃ¡"): se decodifica acá.
function leerLibro(filePath) {
  const buf = fs.readFileSync(filePath);
  const esPlanilla = (buf[0] === 0x50 && buf[1] === 0x4b) || (buf[0] === 0xd0 && buf[1] === 0xcf); // xlsx (zip) / xls
  if (esPlanilla) return XLSX.read(buf, { type: 'buffer', raw: true, cellDates: true });
  let texto;
  if (buf[0] === 0xff && buf[1] === 0xfe) texto = buf.subarray(2).toString('utf16le');
  else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) texto = buf.subarray(3).toString('utf8');
  else {
    try { texto = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { texto = buf.toString('latin1'); }
  }
  return XLSX.read(texto, { type: 'string', raw: true, cellDates: true });
}

function parseFile(filePath) {
  const wb = leerLibro(filePath);
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('El archivo no contiene hojas');
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { raw: true, defval: null });
  return rows
    .map(row => {
      const out = {};
      for (const k of Object.keys(row)) {
        if (String(k).toLowerCase().trim().startsWith('__empty')) continue;
        out[k] = row[k];
      }
      return out;
    })
    .filter(r => Object.values(r).some(v => v != null && v !== ''));
}

async function ensureRubrosTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS articulo_rubros (
        id              SERIAL PRIMARY KEY,
        business_id     BIGINT  NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
        codigo          INTEGER NOT NULL,
        nombre          TEXT    NOT NULL,
        codigo_sua      INTEGER,
        subrubro        TEXT,
        destino         TEXT    NOT NULL DEFAULT 'categoria',
        upload_batch_id TEXT,
        activo          BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (business_id, codigo, destino)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_art_rubros_biz ON articulo_rubros(business_id)`);
    await client.query(`ALTER TABLE articulo_rubros ADD COLUMN IF NOT EXISTS destino TEXT NOT NULL DEFAULT 'categoria'`).catch(() => { });
    await client.query(`ALTER TABLE articulo_rubros ADD COLUMN IF NOT EXISTS upload_batch_id TEXT`).catch(() => { });
  } finally {
    client.release();
  }
}

async function resolveTargetBizId(businessId) {
  const { rows: [biz] } = await pool.query(
    `SELECT created_from, organization_id FROM app_businesses WHERE id = $1`,
    [businessId]
  );
  if (biz?.created_from === 'from_group' && biz.organization_id) {
    const { rows: [root] } = await pool.query(
      `SELECT id FROM app_businesses
        WHERE organization_id = $1
          AND (created_from IS NULL OR created_from = 'manual' OR created_from = 'onboarding')
        ORDER BY id ASC LIMIT 1`,
      [biz.organization_id]
    );
    if (root?.id) return Number(root.id);
  }
  return Number(businessId);
}

// ── Aplicar mapeo del usuario primero, luego alias automáticos como fallback ──
function resolverCampo(row, mapeo, campo, aliases) {
  // Si el usuario asignó explícitamente una columna a este campo, usar esa.
  if (mapeo && typeof mapeo === 'object') {
    for (const [col, rol] of Object.entries(mapeo)) {
      if (rol === campo && row[col] != null && row[col] !== '') {
        return row[col];
      }
    }
  }
  // Fallback: detectar por alias automático
  return getCI(row, aliases);
}

function parseRubrosFile(filePath, mapeo = {}) {
  const rows = parseFile(filePath);
  const out = new Map();
  for (const row of rows) {
    const cod = safeInt(resolverCampo(row, mapeo, 'codigo', ['codigo', 'cod_rua', 'codrua', 'code', 'id', 'cod']));
    const nombre = cleanStr(resolverCampo(row, mapeo, 'nombre', ['nombre', 'name', 'descripcion', 'descripción']));
    if (cod == null || !nombre) continue;
    out.set(cod, nombre);
  }
  return out;
}

function parseSubrubrosFile(filePath, mapeo = {}) {
  const rows = parseFile(filePath);
  const out = new Map();
  for (const row of rows) {
    const cod = safeInt(resolverCampo(row, mapeo, 'codigo', ['codigo', 'cod_sua', 'codsua', 'code', 'id']));
    const nombre = cleanStr(resolverCampo(row, mapeo, 'nombre', ['nombre', 'name', 'descripcion', 'descripción']));
    const rubroCod = safeInt(resolverCampo(row, mapeo, 'rubro', ['cod_rua', 'codrua', 'cod_ru', 'rubro', 'rubro_codigo']));
    if (cod == null || !nombre) continue;
    out.set(cod, { nombre, rubroCodigo: rubroCod });
  }
  return out;
}

function parseArticulosFile(filePath, mapeo = {}) {
  const rows = parseFile(filePath);
  const out = [];
  const errors = [];
  // Si el usuario no mapeó código, vamos a generar IDs negativos secuenciales
  // (como artículos manuales) para que igual se puedan insertar.
  let nextManualId = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let cod = safeInt(resolverCampo(row, mapeo, 'codigo', ['codigo', 'cod_rua', 'codrua', 'cod_ru', 'articulo_id', 'art_id', 'code', 'id']));
    const nombre = cleanStr(resolverCampo(row, mapeo, 'nombre', ['nombre', 'name', 'descripcion', 'descripción', 'denominacion']));

    if (!nombre) {
      errors.push({ row: i + 2, error: 'Sin nombre' });
      continue;
    }
    if (cod == null) {
      // Sin código → asignar ID negativo (manual)
      cod = nextManualId--;
    }

    const codRubro = safeInt(resolverCampo(row, mapeo, 'rubro', ['cod_rua', 'codrua', 'cod_ru', 'rubro_codigo', 'cod_rubro']));
    const codSubrubro = safeInt(resolverCampo(row, mapeo, 'subrubro', ['cod_sua', 'codsua', 'subrubro_codigo', 'cod_subrubro']));
    const precio = parseNum(resolverCampo(row, mapeo, 'precio', ['precio1', 'precio', 'price', 'precio_venta', 'precio_ref', 'p_ref', 'precio2'])) ?? 0;

    out.push({
      articulo_id: cod,
      nombre,
      cod_rubro: codRubro,
      cod_subrubro: codSubrubro,
      precio,
    });
  }
  return { items: out, errors };
}

// ── Función principal ─────────────────────────────────────────────────────

/**
 * Importa rubros + subrubros + artículos en una sola operación con cruce automático.
 *
 * @param {Object} params
 * @param {number} params.businessId
 * @param {string|null} params.rubrosFilePath  - archivo de rubros (opcional)
 * @param {string|null} params.subrubrosFilePath - archivo de subrubros (opcional)
 * @param {string} params.articulosFilePath - archivo de artículos (requerido)
 */
async function importPaired({
  businessId,
  rubrosFilePath, mapeoRubros = {},
  subrubrosFilePath, mapeoSubrubros = {},
  articulosFilePath, mapeoArticulos = {},
}) {

  let rubrosMap = new Map();
  let subrubrosMap = new Map();
  let articulosData = { items: [], errors: [] };
  if (rubrosFilePath) rubrosMap = parseRubrosFile(rubrosFilePath, mapeoRubros);
  if (subrubrosFilePath) subrubrosMap = parseSubrubrosFile(subrubrosFilePath, mapeoSubrubros);
  articulosData = parseArticulosFile(articulosFilePath, mapeoArticulos);

  await ensureRubrosTable();
  const targetBizId = await resolveTargetBizId(businessId);
  const batchId = `paired-art-${Date.now()}`;

  try {
    if (rubrosFilePath) rubrosMap = parseRubrosFile(rubrosFilePath);
    if (subrubrosFilePath) subrubrosMap = parseSubrubrosFile(subrubrosFilePath);
    articulosData = parseArticulosFile(articulosFilePath);
  } catch (e) {
    // Limpiar archivos antes de propagar
    [rubrosFilePath, subrubrosFilePath, articulosFilePath].forEach(p => {
      if (p) try { fs.unlinkSync(p); } catch { }
    });
    throw new Error(`Error al leer archivo: ${e.message}`);
  }

  const client = await pool.connect();
  let txOpen = false;

  try {
    await client.query('BEGIN');
    txOpen = true;

    // ── 2. Upsert de rubros en articulo_rubros ──────────────────────────
    let rubrosInserted = 0, rubrosUpdated = 0;
    for (const [codigo, nombre] of rubrosMap.entries()) {
      const res = await client.query(
        `INSERT INTO articulo_rubros
           (business_id, codigo, nombre, destino, upload_batch_id, updated_at)
         VALUES ($1, $2, $3, 'categoria', $4, NOW())
         ON CONFLICT (business_id, codigo, destino) DO UPDATE SET
           nombre = EXCLUDED.nombre,
           upload_batch_id = EXCLUDED.upload_batch_id,
           activo = TRUE,
           updated_at = NOW()
         RETURNING (xmax = 0) AS is_insert`,
        [targetBizId, codigo, nombre, batchId]
      );
      if (res.rows[0]?.is_insert) rubrosInserted++; else rubrosUpdated++;
    }

    // ── 3. Upsert de subrubros en articulo_rubros (destino=subrubro) ────
    let subrubrosInserted = 0, subrubrosUpdated = 0;
    for (const [codigo, info] of subrubrosMap.entries()) {
      const res = await client.query(
        `INSERT INTO articulo_rubros
           (business_id, codigo, nombre, destino, upload_batch_id, updated_at)
         VALUES ($1, $2, $3, 'subrubro', $4, NOW())
         ON CONFLICT (business_id, codigo, destino) DO UPDATE SET
           nombre = EXCLUDED.nombre,
           upload_batch_id = EXCLUDED.upload_batch_id,
           activo = TRUE,
           updated_at = NOW()
         RETURNING (xmax = 0) AS is_insert`,
        [targetBizId, codigo, info.nombre, batchId]
      );
      if (res.rows[0]?.is_insert) subrubrosInserted++; else subrubrosUpdated++;
    }

    // ── 4. Upsert de artículos con CRUCE automático ──────────────────────
    // categoria ← nombre del rubro (resolviendo cod_rubro vía rubrosMap)
    // subrubro  ← nombre del subrubro (resolviendo cod_subrubro vía subrubrosMap)
    // Si no hay archivo de rubros/subrubros, usamos lo que ya esté en articulo_rubros
    // (cargado en una pasada anterior).
    let artInserted = 0, artUpdated = 0;
    const CHUNK = 200;

    // Cargar lo existente en articulo_rubros para usar de fallback
    const { rows: rubrosExist } = await client.query(
      `SELECT codigo, nombre, destino FROM articulo_rubros
        WHERE business_id = $1 AND activo = TRUE`,
      [targetBizId]
    );
    const rubroNombreByCod = new Map();
    const subrubroNombreByCod = new Map();
    for (const r of rubrosExist) {
      if (r.destino === 'categoria') rubroNombreByCod.set(Number(r.codigo), r.nombre);
      if (r.destino === 'subrubro') subrubroNombreByCod.set(Number(r.codigo), r.nombre);
    }
    // Pisar con lo que vino en este upload (más fresco)
    for (const [cod, nombre] of rubrosMap.entries()) rubroNombreByCod.set(cod, nombre);
    for (const [cod, info] of subrubrosMap.entries()) subrubroNombreByCod.set(cod, info.nombre);

    for (let i = 0; i < articulosData.items.length; i += CHUNK) {
      const chunk = articulosData.items.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      let p = 1;

      for (const it of chunk) {
        const rubroNombre = it.cod_rubro != null
          ? rubroNombreByCod.get(it.cod_rubro) || `Rubro ${it.cod_rubro}`
          : 'Sin categoría';
        const subrubroNombre = it.cod_subrubro != null
          ? subrubroNombreByCod.get(it.cod_subrubro) || null
          : null;

        values.push(`($${p},$${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},'{}'::jsonb,NOW(),$${p + 6},'csv')`);
        params.push(targetBizId, it.articulo_id, it.nombre, rubroNombre, subrubroNombre, it.precio, batchId);
        p += 7;
      }

      const res = await client.query(
        `INSERT INTO maxi_articles
           (business_id, articulo_id, nombre, categoria, subrubro, precio, raw, updated_at, upload_batch_id, origen)
         VALUES ${values.join(',')}
         ON CONFLICT (business_id, articulo_id) DO UPDATE SET
           nombre          = EXCLUDED.nombre,
           categoria       = EXCLUDED.categoria,
           subrubro        = COALESCE(EXCLUDED.subrubro, maxi_articles.subrubro),
           precio          = EXCLUDED.precio,
           upload_batch_id = EXCLUDED.upload_batch_id,
           origen          = COALESCE(maxi_articles.origen, EXCLUDED.origen),
           updated_at      = NOW()
         RETURNING (xmax = 0) AS is_insert`,
        params
      );

      for (const row of res.rows) {
        if (row.is_insert) artInserted++; else artUpdated++;
      }
    }

    await client.query('COMMIT');
    txOpen = false;

    console.log(
      `[importPaired] biz=${targetBizId} batch=${batchId} ` +
      `rubros=${rubrosInserted}+${rubrosUpdated} ` +
      `subrubros=${subrubrosInserted}+${subrubrosUpdated} ` +
      `articulos=${artInserted}+${artUpdated} errors=${articulosData.errors.length}`
    );

    return {
      ok: true,
      batchId,
      target_business_id: targetBizId,
      rubros: { inserted: rubrosInserted, updated: rubrosUpdated, total: rubrosMap.size },
      subrubros: { inserted: subrubrosInserted, updated: subrubrosUpdated, total: subrubrosMap.size },
      articulos: {
        inserted: artInserted,
        updated: artUpdated,
        failed: articulosData.errors.length,
        total: articulosData.items.length + articulosData.errors.length,
      },
      summary: {
        // Para mantener compat con UI que lee summary.inserted/updated
        inserted: artInserted,
        updated: artUpdated,
        failed: articulosData.errors.length,
        total: articulosData.items.length + articulosData.errors.length,
      },
      errors: articulosData.errors.slice(0, 20),
    };

  } catch (e) {
    if (txOpen) { try { await client.query('ROLLBACK'); } catch { } }
    throw e;
  } finally {
    client.release();
    // Limpiar archivos temporales
    [rubrosFilePath, subrubrosFilePath, articulosFilePath].forEach(p => {
      if (p) try { fs.unlinkSync(p); } catch { }
    });
  }
}

// ── Import de un solo archivo de artículos (tabla de Artículos y alta manual) ──
// La ruta /articles/import-csv llamaba a esta función, que no existía (fallaba siempre). Reglas
// (pedido de la usuaria, 2026-11-09): si el archivo trae código se usa; si no, se toma nombre y
// precio y el código se asigna solo (negativo, como un artículo creado a mano, siguiendo al menor
// que ya tenga el negocio para no pisar ninguno). Rubro/subrubro pueden venir como texto o código.
const CAMPOS_ARTICULO = ['codigo', 'nombre', 'precio', 'rubro', 'subrubro'];

// El front manda { campo: columna }; resolverCampo espera { columna: campo }. Se aceptan los dos.
function normalizarMapeo(mapeo) {
  if (!mapeo || typeof mapeo !== 'object') return {};
  const claves = Object.keys(mapeo);
  const esCampoAColumna = claves.length && claves.every((k) => CAMPOS_ARTICULO.includes(k));
  if (!esCampoAColumna) return mapeo;
  const out = {};
  for (const [campo, col] of Object.entries(mapeo)) if (col) out[col] = campo;
  return out;
}

async function importArticulosFromFile({ businessId, filePath, mapeo = {} }) {
  const m = normalizarMapeo(mapeo);
  const targetBizId = await resolveTargetBizId(businessId);
  const client = await pool.connect();
  let txOpen = false;
  try {
    const rows = parseFile(filePath);
    const { rows: nombresRubro } = await client.query(
      `SELECT codigo, nombre, destino FROM articulo_rubros WHERE business_id = $1`, [targetBizId]).catch(() => ({ rows: [] }));
    const rubroPorCod = new Map(nombresRubro.filter((r) => r.destino === 'categoria').map((r) => [Number(r.codigo), r.nombre]));
    const subPorCod = new Map(nombresRubro.filter((r) => r.destino === 'subrubro').map((r) => [Number(r.codigo), r.nombre]));
    const texto = (v, porCod) => {
      const s = cleanStr(v);
      if (!s) return null;
      return /^\d+$/.test(s) ? (porCod.get(Number(s)) || `Rubro ${s}`) : s;
    };

    const { rows: minRow } = await client.query(
      `SELECT LEAST(COALESCE(MIN(articulo_id), 0), 0) AS m FROM maxi_articles WHERE business_id = $1`, [targetBizId]);
    let nextManual = Number(minRow[0]?.m || 0) - 1;

    const items = [];
    const errors = [];
    const vistos = new Set();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const nombre = cleanStr(resolverCampo(row, m, 'nombre', ['nombre', 'name', 'descripcion', 'descripción', 'denominacion', 'articulo', 'artículo', 'producto']));
      if (!nombre) { errors.push({ row: i + 2, error: 'Sin nombre' }); continue; }
      let cod = safeInt(resolverCampo(row, m, 'codigo', ['codigo', 'código', 'cod', 'cod_art', 'articulo_id', 'art_id', 'code', 'sku', 'id']));
      if (cod == null || cod === 0) cod = nextManual--;
      if (vistos.has(cod)) { errors.push({ row: i + 2, error: `Código repetido en el archivo: ${cod}` }); continue; }
      vistos.add(cod);
      const precio = parseNum(resolverCampo(row, m, 'precio', ['precio', 'precio1', 'price', 'precio_venta', 'pvp', 'importe'])) ?? 0;
      const rubro = texto(resolverCampo(row, m, 'rubro', ['rubro', 'categoria', 'categoría', 'familia', 'grupo']), rubroPorCod) || 'Sin categoría';
      const subrubro = texto(resolverCampo(row, m, 'subrubro', ['subrubro', 'subcategoria', 'subcategoría', 'subfamilia']), subPorCod) || 'Sin subrubro';
      items.push({ articulo_id: cod, nombre: nombre.slice(0, 200), categoria: rubro, subrubro, precio });
    }

    const CHUNK = 200;
    const batchId = `csv-art-${Date.now()}`;
    let inserted = 0, updated = 0;
    await client.query('BEGIN');
    txOpen = true;
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      let p = 1;
      for (const it of chunk) {
        values.push(`($${p},$${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},'{}'::jsonb,NOW(),$${p + 6},'csv')`);
        params.push(targetBizId, it.articulo_id, it.nombre, it.categoria, it.subrubro, it.precio, batchId);
        p += 7;
      }
      const res = await client.query(
        `INSERT INTO maxi_articles
           (business_id, articulo_id, nombre, categoria, subrubro, precio, raw, updated_at, upload_batch_id, origen)
         VALUES ${values.join(',')}
         ON CONFLICT (business_id, articulo_id) DO UPDATE SET
           nombre = EXCLUDED.nombre, categoria = EXCLUDED.categoria, subrubro = EXCLUDED.subrubro,
           precio = EXCLUDED.precio, upload_batch_id = EXCLUDED.upload_batch_id,
           origen = COALESCE(maxi_articles.origen, EXCLUDED.origen), updated_at = NOW()
         RETURNING (xmax = 0) AS is_insert`, params);
      for (const r of res.rows) { if (r.is_insert) inserted++; else updated++; }
    }
    await client.query('COMMIT');
    txOpen = false;
    const total = items.length + errors.length;
    return {
      ok: true, batchId, target_business_id: targetBizId,
      summary: { inserted, updated, failed: errors.length, total },
      articulos: { inserted, updated, failed: errors.length, total },
      errors: errors.slice(0, 20),
    };
  } catch (e) {
    if (txOpen) { try { await client.query('ROLLBACK'); } catch { /* nada */ } }
    throw e;
  } finally {
    client.release();
    try { fs.unlinkSync(filePath); } catch { /* ya no está */ }
  }
}

module.exports = { importPaired, importArticulosFromFile, parseFile, normalizarMapeo };