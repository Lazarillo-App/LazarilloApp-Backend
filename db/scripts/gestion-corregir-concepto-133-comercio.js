// db/scripts/gestion-corregir-concepto-133-comercio.js
//
// Corrige el concepto 133 de la organización NUÑEZ (Comercio, 210). En el MaxiRest de Comercio
// el 133 se usó hasta ago-2025 para "Contrib. SS 358" (AFIP cargas sociales / autónomos) y desde
// 2025 para la percepción de IVA de las facturas de proveedores, pero el maestro quedó llamado
// "Contrib. Ss 358": las percepciones de Pepsi, Makro, etc. aparecían como contribución.
//
//   1. Concepto 133 → "Percepcion Iva", rubro 4 (Impuestos), editadoEnLazarillo = true
//      (la sincronización no pisa nombre / rubro de un concepto editado en Lazarillo).
//   2. Las compras viejas de AFIP (texto "Contrib. SS 358") → conceptoCodigoManual = '771'
//      ("Contribuciones Ss 351", Gastos en Personal). La reimportación no pisa los manuales.
//
// DRY-RUN por defecto (muestra y deshace). Con --aplicar hace COMMIT.
// Uso: node db/scripts/gestion-corregir-concepto-133-comercio.js [--aplicar]
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

const ORGANIZACION = 20; // NUÑEZ
const CONCEPTO = '133';
const NOMBRE_NUEVO = 'Percepcion Iva';
const RUBRO_IMPUESTOS = '4';
const CONCEPTO_AFIP = '771'; // Contribuciones Ss 351 (Gastos en Personal)

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  console.log(aplicar ? 'APLICANDO' : 'DRY-RUN (se ejecuta y se deshace)', '\n');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    const { rows: antes } = await c.query(
      `SELECT codigo, nombre, "codRga", "nombreMaxirest", "editadoEnLazarillo" FROM gestion_conceptos_caja
        WHERE organization_id = $1 AND codigo IN ($2, $3)`, [ORGANIZACION, CONCEPTO, CONCEPTO_AFIP]);
    console.log('Conceptos antes:'); console.table(antes);
    if (!antes.some((r) => r.codigo === CONCEPTO) || !antes.some((r) => r.codigo === CONCEPTO_AFIP)) {
      throw new Error(`Falta el concepto ${CONCEPTO} o el ${CONCEPTO_AFIP} en la organización ${ORGANIZACION}`);
    }
    const { rowCount: n1 } = await c.query(
      `UPDATE gestion_conceptos_caja SET nombre = $3, "codRga" = $4, "editadoEnLazarillo" = true
        WHERE organization_id = $1 AND codigo = $2`, [ORGANIZACION, CONCEPTO, NOMBRE_NUEVO, RUBRO_IMPUESTOS]);
    console.log(`Concepto ${CONCEPTO} renombrado: ${n1}`);

    // Compras de AFIP cargadas con el 133 (por su texto de origen), sin concepto manual previo.
    const { rows: afip } = await c.query(
      `UPDATE gestion_compras co SET "conceptoCodigoManual" = $3
         FROM app_businesses b
        WHERE b.id = co.business_id AND b.organization_id = $1
          AND co."conceptoCodigo" = $2 AND co."conceptoCodigoManual" IS NULL
          AND co.concepto ILIKE 'contrib%'
        RETURNING co."rowId", co.business_id, co.fecha::date AS fecha, co.importe, co.concepto`,
      [ORGANIZACION, CONCEPTO, CONCEPTO_AFIP]);
    console.log(`\nCompras de AFIP pasadas al ${CONCEPTO_AFIP}: ${afip.length}`); console.table(afip);

    const { rows: resto } = await c.query(
      `SELECT co.concepto, COUNT(*)::int AS n, MIN(co.fecha)::date AS desde, MAX(co.fecha)::date AS hasta
         FROM gestion_compras co JOIN app_businesses b ON b.id = co.business_id
        WHERE b.organization_id = $1 AND COALESCE(co."conceptoCodigoManual", co."conceptoCodigo") = $2
        GROUP BY 1`, [ORGANIZACION, CONCEPTO]);
    console.log(`\nLo que queda en el ${CONCEPTO} ("${NOMBRE_NUEVO}"):`); console.table(resto);

    if (aplicar) { await c.query('COMMIT'); console.log('\nOK — aplicado.'); }
    else { await c.query('ROLLBACK'); console.log('\nDRY-RUN OK — nada quedó guardado. Agregá --aplicar para dejarlo.'); }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

main();
