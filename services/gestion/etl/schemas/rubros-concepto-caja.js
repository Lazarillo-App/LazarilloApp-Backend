// Portado de lazarillo_gestion/lib/etl/schemas/rubros-concepto-caja.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { z } = require('zod');
const { excelText, excelNormalizedText, requiredExcelText } = require('./common');

const rubroConceptoCajaRowSchema = z.object({
  CODIGO: requiredExcelText,
  NOMBRE: excelNormalizedText,
  CALC_RENT: excelText,
});

module.exports = { rubroConceptoCajaRowSchema };
