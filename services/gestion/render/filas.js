// Portado de lazarillo_gestion/lib/render/filas.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Filas de Render (tablas que sube el kit: container.i14_…_2026, etc.) → filas
// iguales a las que lee el import desde el Excel (ver readExcelBuffer), para que
// pasen por el MISMO normalizer y den el MISMO rowId: leer de Render y después
// importar el Excel (o al revés) actualiza los mismos registros, no duplica.
//
// Diferencias que hay que deshacer (medidas con los V7 reales de Bar 2026):
// - Claves en minúscula y columna `pdv` extra.
// - Fechas: Render trae timestamp; el Excel, serial de Excel (días desde 1899-12-30).
// - Números: pg devuelve numeric/bigint como texto.
// - Texto: el Excel trae cada campo relleno con espacios al ancho fijo de MaxiRest
//   ("Mañ" → "Mañ"+espacios, vacío → todo espacios) y Render lo trae recortado o
//   null. Algunos rowId (ventas, detalle de compras) hashean el valor crudo, así
//   que se vuelve a rellenar al ancho de cada columna.

// Ancho fijo de cada columna de texto en los Excel de MaxiRest (14, 22, 25, 80).
const ANCHOS = {
  CONCEPTO: 25, PROVEEDOR: 30, DETALLE: 30, OBSERVAC: 40, IMPUTAC: 8,
  TURNO: 3, COMPROBANT: 20, HORA: 5, TIPO: 5, MESA: 4, MOZO: 20, COBRO: 17, COD_COBRO: 1,
  CLINOMBRE: 50, CLIRAZON: 35, CLICUIT: 35, NOMBRESUC: 60,
  COD_CPB: 1, NOMBRE: 30, MEDIDA: 5, NOM_CGA: 30,
  NOM_PRO: 30, NOM_RGA: 30, NOM_CTG: 30, PAGO: 30, NOM_BAN: 30,
};

// OIDs de Postgres → cómo convertir.
const OID_FECHA = new Set([1082, 1114, 1184]);
const OID_NUMERO = new Set([20, 21, 23, 700, 701, 1700]);

function tipoDeOid(oid) {
  if (OID_FECHA.has(oid)) return "fecha";
  if (OID_NUMERO.has(oid)) return "numero";
  return "texto";
}

// "2026-01-02 13:09:00" / "2026-01-02" / "2026-01-02T00:00:00Z" → serial de Excel.
function serialExcel(valor) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(valor);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = m;
  const dias = Date.UTC(+y, +mo - 1, +d) / 86_400_000 + 25_569;
  const fraccion = (+h * 3600 + +mi * 60 + +s) / 86_400;
  return fraccion ? dias + fraccion : dias;
}

// El kit (inf22_pdv.py) escribe el comprobante del 22 como "  %-3s %04d-%08d ":
// dos espacios ADELANTE ("  FCB 0006-00004888 "), y Render lo guarda recortado
// ("FCB 0006-00004888"). El rowId de ventas hashea el comprobante crudo, así que
// se rearma igual que en el Excel (si no, la misma venta leída de Render y del
// Excel daría dos registros).
// Ojo: las letras de una sola posición ("U", "_", "Y") vienen con varios espacios ("U   0006-…");
// antes el patrón pedía UN espacio, esas no se rearmaban y daban otro rowId → venta duplicada
// (San Justo, Comercio; Diego 29/10/2026).
function comprobanteDelExcel(s) {
  const m = /^(\S+)\s+(\d{4}-\d{8})$/.exec(s.trim());
  return m ? `  ${m[1].padEnd(3)} ${m[2]} ` : null;
}

// HORA: en el Excel es fracción del día (13:09 → 0,5479…); Render la trae "13:09:00".
function horaDelExcel(s) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  // 16 cifras: así lo escribe openpyxl en el .xlsx del kit (0,010416666666666666 → 0,01041666666666667).
  return m ? Number(((+m[1] * 3600 + +m[2] * 60 + +(m[3] ?? 0)) / 86_400).toPrecision(16)) : null;
}

function filaDeRender(fila, tipos) {
  const out = {};
  for (const [col, valor] of Object.entries(fila)) {
    if (col === "pdv" || col === "fila") continue;
    const clave = col.toUpperCase();
    const tipo = tipos[col] ?? "texto";
    if (tipo === "texto") {
      const ancho = ANCHOS[clave];
      if (valor == null) {
        if (ancho != null) out[clave] = "".padEnd(ancho);
        continue;
      }
      const s = String(valor);
      if (clave === "COMPROBANT") {
        const c = comprobanteDelExcel(s);
        if (c) { out[clave] = c; continue; }
      }
      if (clave === "HORA") {
        const h = horaDelExcel(s);
        if (h != null) { out[clave] = h; continue; }
      }
      out[clave] = ancho != null ? s.padEnd(ancho) : s;
      continue;
    }
    if (valor == null) continue;
    if (tipo === "fecha") {
      const n = valor instanceof Date ? serialExcel(valor.toISOString()) : serialExcel(String(valor));
      if (n != null) out[clave] = n;
      continue;
    }
    const n = Number(valor);
    if (Number.isFinite(n)) out[clave] = n;
  }
  return out;
}

// Informes de Render que el Panel lee, con el tipo de archivo que reconoce el ETL.
// Orden = orden de dependencia (compras antes que detalle/pagos).
// Ventas (22) necesita el orden de las filas: sus cobros partidos heredan
// turno/comprobante de la fila anterior, y una tabla de Postgres no garantiza el
// orden. Desde el 26/10/2026 el kit sube la columna `fila`; cada PDV se lee recién
// cuando TODAS sus filas la tienen (ver leerCargas).
// `maestro`: tabla de la organización (sin columna pdv, ej. m17); se lee entera.
// En Lazarillo se suman los maestros de proveedores (m00) y artículos (m6): gestion
// los cargaba desde los Excel de Drive y la lectura de Render los exigía ya cargados;
// el kit los sube igual que el m17, así que salen de acá (mismas columnas que el Excel).
const INFORMES_RENDER = [
  { prefijo: "m00_listado_de_proovedores", fileType: "proveedores", nombre: "Proveedores (maestro 00)", maestro: true },
  { prefijo: "m6_listado_de_articulos", fileType: "articulos", nombre: "Artículos (maestro 6)", maestro: true },
  { prefijo: "m17_conceptos_de_caja", fileType: "conceptosCaja", nombre: "Conceptos de caja (maestro 17)", maestro: true },
  { prefijo: "i14_gastos_compras_detallado", fileType: "compras", nombre: "14 · gastos y compras" },
  { prefijo: "i25_compras_detalle_de_compras", fileType: "detalleCompras", nombre: "25 · detalle de compras" },
  { prefijo: "i80_compras_detalle_de_pagos", fileType: "pagos", nombre: "80 · pagos" },
  { prefijo: "i000_nomina", fileType: "nomina", nombre: "Nómina" },
  { prefijo: "i22_ventas_detalladas", fileType: "ventas", nombre: "22 · ventas", requiereOrden: true },
];

// "i14_gastos_compras_detallado_2026" → { informe, anio: 2026 }; null si no es del Panel.
function informeDeTabla(tabla) {
  for (const informe of INFORMES_RENDER) {
    if (tabla === informe.prefijo) return { informe, anio: null };
    const m = new RegExp(`^${informe.prefijo}_(\\d{4})$`).exec(tabla);
    if (m) return { informe, anio: Number(m[1]) };
  }
  return null;
}

module.exports = { ANCHOS, tipoDeOid, serialExcel, comprobanteDelExcel, horaDelExcel, filaDeRender, INFORMES_RENDER, informeDeTabla };
