// Portado de lazarillo_gestion/lib/etl/schemas/ventas.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { z } = require('zod');
const { excelDecimal, excelDate, excelText } = require('./common');

// A diferencia de compras, FECHA NO es obligatoria acá: las filas secundarias de
// pago partido (misma venta, múltiples formas de cobro) llegan con FECHA vacía
// del ERP y el dashboard las excluye con WHERE fecha IS NOT NULL — es un estado
// válido, no un dato faltante. Sigue siendo excelDate (no excelText) para que una
// FECHA presente pero corrupta caiga en errors en vez de null en silencio.
const ventaRowSchema = z.object({
  TURNO: excelText,
  COMPROBANT: excelText,
  HORA: excelText,
  TIPO: excelText,
  MESA: excelText,
  MOZO: excelText,
  CUB: excelText,
  COBRO: excelText,
  COD_COBRO: excelText,
  IMPORTE: excelDecimal,
  TOTAL: excelDecimal,
  DESCUENTO: excelDecimal,
  CLINOMBRE: excelText,
  CLIRAZON: excelText,
  CLICUIT: excelText,
  FECHA: excelDate,
  COD_SUC: excelText,
  NOMBRESUC: excelText,
  CUPON: excelText,
});

module.exports = { ventaRowSchema };
