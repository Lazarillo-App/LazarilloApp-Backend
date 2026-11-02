// Portado de lazarillo_gestion/lib/etl/schemas/pagos.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { z } = require('zod');
const { excelDecimal, excelDate, excelText, excelNormalizedText, requiredExcelText, requiredExcelDate } = require('./common');

// Informe 80 de MaxiRest ("compras - detalle de pagos"): una fila por pago
// aplicado a un comprobante. FECHA_PAGO y COD_CPB son identificadores: una
// fila sin ellos no se puede ubicar (va a skippedRows como sin_datos antes de
// llegar acá); presentes pero corruptos caen en errors.
const pagoRowSchema = z.object({
  FECHA: excelDate,              // fecha de la factura
  COD_CPB: requiredExcelText,    // A / C / Z (ticket) / P (pago a cuenta)
  PREFIJO: excelText,
  NUMERO: excelText,
  COD_PRO: excelText,
  NOM_PRO: excelNormalizedText,
  TOTAL: excelDecimal,           // total del comprobante
  COD_CGA: excelText,            // gasto vario: concepto de caja ("0" = no aplica)
  NOM_CGA: excelNormalizedText,
  PAGO: excelNormalizedText,     // medio: CAJA MAYOR / BANCOS
  IMPORTE: excelDecimal,         // importe de este pago
  FECHA_PAGO: requiredExcelDate,
  ORDEN: excelText,
  FECHA_VAL: excelDate,
  NUMERO_VAL: excelText,
  COD_BAN: excelText,
  NOM_BAN: excelNormalizedText,
  IMP_VAL: excelDecimal,
});

module.exports = { pagoRowSchema };
