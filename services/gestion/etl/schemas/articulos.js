// Portado de lazarillo_gestion/lib/etl/schemas/articulos.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { z } = require('zod');
const { excelDecimal, excelNormalizedText, excelInt, requiredExcelText } = require('./common');

const articuloRowSchema = z.object({
  CODIGO: requiredExcelText,
  NOMBRE: excelNormalizedText,
  PRECIO1: excelDecimal,
  PRECIO2: excelDecimal,
  PRECIO3: excelDecimal,
  PRECIO4: excelDecimal,
  COD_RUA: excelInt,
  COD_SUA: excelInt,
});

module.exports = { articuloRowSchema };
