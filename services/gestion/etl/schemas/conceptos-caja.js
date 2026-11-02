// Portado de lazarillo_gestion/lib/etl/schemas/conceptos-caja.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { z } = require('zod');
const { excelText, excelNormalizedText, excelInt, requiredExcelText } = require('./common');

const conceptoCajaRowSchema = z.object({
  CODIGO: requiredExcelText,
  NOMBRE: excelNormalizedText,
  TIPO: excelText,
  COD_IMP: excelText,
  COD_RGA: excelInt,
});

module.exports = { conceptoCajaRowSchema };
