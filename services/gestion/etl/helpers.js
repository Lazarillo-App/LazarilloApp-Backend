// Portado de lazarillo_gestion/lib/etl/helpers.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const XLSX = require('xlsx');

// ─── Primitivos ───────────────────────────────────────────────────────────────

function trim(val) {
  if (val == null) return null;
  const s = String(val).trim();
  return s === "" ? null : s;
}

function toDecimal(val) {
  if (val == null || val === "" || val === " ") return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

// Para campos monetarios (Decimal? en Prisma): devuelve string para preservar
// precisión completa y evitar drift de punto flotante IEEE 754.
function toDecimalStr(val) {
  if (val == null || val === "" || val === " ") return null;
  const s = String(val).trim();
  if (s === "" || isNaN(Number(s))) return null;
  return s;
}

function toBool(val) {
  if (val == null) return null;
  if (typeof val === "boolean") return val;
  if (val === 1 || val === "1" || val === "true") return true;
  if (val === 0 || val === "0" || val === "false") return false;
  return null;
}

function excelDateToISO(val) {
  if (val == null || val === false || val === "") return null;
  if (typeof val === "number") {
    // Fechas imposibles (caso real: -601570 en un 14 de Comercio, un adelanto
    // con la fecha rota en MaxiRest) → parse_date_code devuelve null o un año
    // absurdo. Antes reventaba con "Cannot read properties of null (reading 'y')"
    // y frenaba el archivo entero; ahora es "fecha inválida" y esa fila sola va a
    // errores con su fila completa.
    if (!Number.isFinite(val) || val <= 0) return null;
    const date = XLSX.SSF.parse_date_code(val);
    if (!date || date.y < 1900) return null;
    return `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
  }
  return null;
}

// Convierte un valor Excel de fecha a Date, validando el resultado.
function safeDate(val) {
  const iso = excelDateToISO(val);
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

// ─── Normalización de texto ───────────────────────────────────────────────────

function normalizeText(val) {
  if (val == null) return null;
  let s = String(val);
  s = s.trim();
  s = s.replace(/[\x00-\x1F\x7F]/g, "");
  s = s.replace(/\s+/g, " ");
  s = s.replace(/--+/g, "-");
  s = s
    .toLowerCase()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  s = s.trim();
  return s === "" ? null : s;
}

// ─── Normalización de campos estructurados ───────────────────────────────────

function normalizePhone(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (s === "") return null;
  if (/^[\d\s\-()+]+$/.test(s)) return s.replace(/\s+/g, "");
  return s;
}

function normalizeCuit(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (s === "") return null;
  return s.replace(/[-\s]/g, "");
}

// ─── Excel ────────────────────────────────────────────────────────────────────

// Normaliza todas las keys a UPPERCASE para acceso consistente en todos los normalizers.
// Carga el workbook completo en memoria (SheetJS no ofrece streaming real en la versión
// libre) — riesgo aceptado: app/api/etl/drive-import/route.ts limita cada archivo a 10 MB
// (MAX_SIZE), lo que acota el impacto. Revisar si ese cap deja de alcanzar en la práctica.
function readExcelBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  if (!wb.SheetNames.length) return [];
  const rows = XLSX.utils.sheet_to_json (wb.Sheets[wb.SheetNames[0]]);
  return rows.map((r) => {
    const normalized = {};
    for (const key of Object.keys(r)) {
      normalized[key.trim().toUpperCase()] = r[key];
    }
    // sheet_to_json deja el índice de fila de la hoja (0-based) como propiedad no
    // enumerable; se conserva igual (no enumerable, no es una columna) para que
    // filaCruda() pueda decir la fila real del Excel aunque haya filas en blanco.
    const rowNum = (r).__rowNum__;
    if (typeof rowNum === "number") Object.defineProperty(normalized, "__rowNum__", { value: rowNum, enumerable: false });
    return normalized;
  });
}

function getExcelHeaders(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  if (!wb.SheetNames.length) return [];
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const [headerRow] = XLSX.utils.sheet_to_json (sheet, { header: 1 });
  return Array.isArray(headerRow) ? (headerRow) : [];
}

// Fila del archivo completa, para mostrarla en Importar (ver ETLFilaCruda). Número
// de fila real del Excel si la hoja lo trajo (encabezado = 1), si no el índice +2.
// Las celdas de fecha que vienen como serial de Excel se muestran dd/mm/aaaa; el
// resto tal cual, como texto.
function filaCruda(r, idx) {
  const rowNum = (r).__rowNum__;
  const fila = typeof rowNum === "number" ? rowNum + 1 : idx + 2;
  const columnas = {};
  for (const key of Object.keys(r)) {
    const v = r[key];
    if (v == null) { columnas[key] = ""; continue; }
    if (typeof v === "number" && /FECHA|FEC_|^FEC$/i.test(key)) {
      const iso = excelDateToISO(v);
      if (iso) { const [y, m, d] = iso.split("-"); columnas[key] = `${d}/${m}/${y}`; continue; }
    }
    columnas[key] = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  }
  return { fila, columnas };
}

module.exports = { trim, toDecimal, toDecimalStr, toBool, excelDateToISO, safeDate, normalizeText, normalizePhone, normalizeCuit, readExcelBuffer, getExcelHeaders, filaCruda };
