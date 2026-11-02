// Portado de lazarillo_gestion/lib/etl/schemas/rubros-articulo.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { z } = require('zod');
const { excelDate, excelText, excelNormalizedText, excelBool, excelDecimalOrBool, requiredExcelText } = require('./common');

const rubroArticuloRowSchema = z.object({
  CODIGO: requiredExcelText,
  NOMBRE: excelNormalizedText,
  COLOR: excelText,
  GRUPO_NRO: excelText,
  GRUPO_COL: excelText,
  GRUPO_FOT: excelText,
  EXCLUYEINF: excelBool,
  EVENTO: excelText,
  DELIACT: excelBool,
  EVE_FOR: excelText,
  EVE_FORM: excelText,
  EVE_FORMH: excelText,
  // ERP exporta DISCONT (flag "discontinuado") como booleano real (true/false),
  // no como decimal, a pesar de que la columna en Prisma sigue siendo Decimal?
  // (legado, write-only, ningún otro lugar de la app la lee; cambiarla a
  // Boolean requeriría una migración para un campo sin consumidor real).
  // excelDecimalOrBool (lib/etl/schemas/common.ts) tolera ambos formatos y
  // convierte boolean a "1"/"0" para encajar en la columna existente sin
  // migración. Detectado en producción 24-ago-2026: el 100% de las filas de
  // un reimport real fallaban por esto.
  DISCONT: excelDecimalOrBool,
  FECHA_UPDA: excelDate,
  MODO_VISTA: excelText,
});

module.exports = { rubroArticuloRowSchema };
