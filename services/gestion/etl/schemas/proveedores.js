// Portado de lazarillo_gestion/lib/etl/schemas/proveedores.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { z } = require('zod');
const { excelText, excelNormalizedText, excelPhone, excelCuit, excelInt, excelBool, requiredExcelText } = require('./common');

const proveedorRowSchema = z.object({
  CODIGO: requiredExcelText,
  NOMBRE: excelNormalizedText,
  RAZON: excelNormalizedText,
  DIRECCION: excelNormalizedText,
  LOCALIDAD: excelNormalizedText,
  CONTACTO: excelNormalizedText,
  TELEFONO: excelPhone,
  FAX: excelPhone,
  CELULAR: excelPhone,
  TIPO_IVA: excelText,
  CUIT: excelCuit,
  CBU: excelText,
  ALIASCBU: excelText,
  DIAS_VENC: excelInt,
  IVA: excelBool,
  IVA_DIF: excelBool,
  E_MAIL: excelText,
  OBSERVAC: excelNormalizedText,
  DETPERC: excelText,
});

module.exports = { proveedorRowSchema };
