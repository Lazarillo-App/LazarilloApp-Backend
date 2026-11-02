// Portado de lazarillo_gestion/lib/etl/schemas/subrubros-articulo.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { z } = require('zod');
const { excelDate, excelText, excelNormalizedText, excelBool, excelInt, requiredExcelText } = require('./common');

const subrubroArticuloRowSchema = z.object({
  CODIGO: requiredExcelText,
  NOMBRE: excelNormalizedText,
  DELIACT: excelBool,
  EVE_FOR: excelText,
  EVE_FORM: excelText,
  EVE_FORMH: excelText,
  FECHA_UPDA: excelDate,
  COD_RUA: excelInt,
});

module.exports = { subrubroArticuloRowSchema };
