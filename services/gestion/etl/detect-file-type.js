// Portado de lazarillo_gestion/lib/etl/detect-file-type.ts (TypeScript → JavaScript, misma lógica).
'use strict';



// Orden importa: más específico primero para evitar falsos positivos.
const DETECTION_RULES = [
  ["rubrosArticulo",     ["GRUPO_NRO", "GRUPO_COL", "GRUPO_FOT", "EXCLUYEINF"]],
  ["subrubrosArticulo",  ["EVE_FOR", "EVE_FORM", "EVE_FORMH"]],
  ["rubrosConceptoCaja", ["CODIGO", "NOMBRE", "CALC_RENT"]],
  ["conceptosCaja",      ["TIPO", "COD_IMP", "COD_RGA"]],
  ["articulos",          ["PRECIO1", "PRECIO2", "PRECIO3", "PRECIO4"]],
  ["proveedores",        ["RAZON", "CUIT", "CBU", "ALIASCBU"]],
  // Informe 80 (detalle de pagos): trae COD_CGA como compras, pero no IMPUTAC/PER1.
  // 000 - nomina del kit (empleados de MaxiRest, columnas en minúscula).
  ["nomina",             ["NOMBREUSU", "APELLIDO", "FECHA_ING", "FECHA_BAJA"]],
  ["pagos",              ["FECHA_PAGO", "PAGO", "ORDEN", "COD_CPB"]],
  ["detalleCompras",     ["COD_CPB", "NUMERO1", "NUMERO2", "TOTALINS"]],
  ["compras",            ["COD_CGA", "IMPUTAC", "PER1"]],
  ["ventas",             ["TURNO", "COMPROBANT", "COBRO", "COD_COBRO"]],
];

function detectFileType(headers) {
  const headerSet = new Set(headers.map((h) => h.trim().toUpperCase()));
  for (const [fileType, required] of DETECTION_RULES) {
    if (required.every((h) => headerSet.has(h))) {
      return fileType;
    }
  }
  return null;
}

function buildTipoNoIdentificadoMessage(headers) {
  return `No se pudo identificar el tipo de archivo. Columnas encontradas: ${headers.join(", ")}`;
}

module.exports = { detectFileType, buildTipoNoIdentificadoMessage };
