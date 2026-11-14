// services/conciliacionMaxiService.js
// Conciliación sin subir archivos (usuaria 13/11/2026): las ventas detalladas (informe 22) y las
// cobranzas de cuenta corriente (informe 72, "Cta. Cte. por comprobante": trae COBRANZA y
// FECHACOB) se leen de las tablas que el kit de MaxiRest sube a Render todos los días, en lugar
// del Excel. Confirmado 14/11: es el 72. El kit hoy lo sube con el nombre viejo
// (i71_cta_por_comprobante_<año>); si algún día se renombra a i72_…, se lee esa.
//
// Las filas salen con filaDeRender (el mismo convertidor del Panel de Gestión): quedan IGUALES a
// las del Excel (claves en mayúscula, fechas como serial, hora como fracción del día), así el
// front las pasa por los mismos lectores del módulo de Diego sin tocar su lógica.
'use strict';

const pool = require('../config/db');
const { pdvsDeNegocio, refrescarPdvMap } = require('./maxiPdvMap');
const { filaDeRender, tipoDeOid } = require('./gestion/render/filas');

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_IDENT = /^[a-z_][a-z0-9_]*$/;
const MAX_DIAS = 92;

/** El punto de venta de MaxiRest de esa sucursal (0 = la principal), o null si no tiene kit. */
function pdvDeSucursal(businessId, sucursal) {
  const suc = Number(sucursal) || 0;
  return pdvsDeNegocio(businessId).find((p) => (suc === 0 ? p.branchId == null : Number(p.branchId) === suc)) || null;
}

function validarRango(desde, hasta) {
  if (!RE_FECHA.test(String(desde || '')) || !RE_FECHA.test(String(hasta || ''))) return { error: 'fechas_invalidas' };
  if (desde > hasta) return { error: 'fechas_invalidas' };
  const dias = (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86400000;
  if (dias > MAX_DIAS) return { error: 'periodo_muy_largo' };
  return { desde, hasta };
}

/** Tablas anuales de un informe en el esquema (i22_ventas_detalladas_2026, …) con sus columnas. */
async function tablasDe(schema, prefijo) {
  const { rows } = await pool.query(
    `SELECT c.table_name, array_agg(c.column_name::text) AS cols
       FROM information_schema.columns c
      WHERE c.table_schema = $1 AND c.table_name ~ $2
      GROUP BY c.table_name ORDER BY c.table_name`,
    [schema, `^${prefijo}_[0-9]{4}$`]);
  return rows.map((r) => ({ tabla: r.table_name, anio: Number(r.table_name.slice(-4)), cols: new Set(r.cols) }));
}

/** Filas del pdv con la columna de fecha dentro del rango, en el orden del informe. */
async function leer(schema, t, pdv, colFecha, desde, hasta) {
  if (!t.cols.has(colFecha) || !t.cols.has('pdv')) return [];
  const orden = t.cols.has('fila') ? 'fila' : colFecha;
  const r = await pool.query(
    `SELECT * FROM "${schema}"."${t.tabla}"
      WHERE pdv = $1 AND "${colFecha}"::date BETWEEN $2::date AND $3::date
      ORDER BY "${orden}"`, [pdv, desde, hasta]);
  const tipos = Object.fromEntries(r.fields.map((f) => [f.name, tipoDeOid(f.dataTypeID)]));
  return r.rows.map((f) => filaDeRender(f, tipos));
}

/** ¿Hay datos de MaxiRest para esta sucursal? Y hasta qué día llegan. */
async function estado(businessId, sucursal) {
  await refrescarPdvMap();
  const p = pdvDeSucursal(businessId, sucursal);
  if (!p || !RE_IDENT.test(p.schema)) return { disponible: false };
  const tablas = await tablasDe(p.schema, 'i22_ventas_detalladas');
  const ultima = tablas.filter((t) => t.cols.has('fecha') && t.cols.has('pdv')).pop();
  let hasta = null;
  if (ultima) {
    const { rows } = await pool.query(
      `SELECT max(fecha)::date::text AS hasta FROM "${p.schema}"."${ultima.tabla}" WHERE pdv = $1`, [p.pdv]);
    hasta = rows[0]?.hasta || null;
  }
  return { disponible: tablas.length > 0, pdv: p.pdv, datos_hasta: hasta };
}

/**
 * Ventas (22) y cobranzas de cuenta corriente (72) del período, como filas de Excel.
 * Las cobranzas se filtran por la fecha del COBRO (FECHACOB): una factura de octubre cobrada en
 * noviembre está en la tabla de octubre, por eso se leen todas las tablas del 71.
 */
async function traer(businessId, sucursal, desde, hasta) {
  const v = validarRango(desde, hasta);
  if (v.error) return v;
  await refrescarPdvMap();
  const p = pdvDeSucursal(businessId, sucursal);
  if (!p || !RE_IDENT.test(p.schema)) return { error: 'sin_maxirest' };
  const a0 = Number(desde.slice(0, 4));
  const a1 = Number(hasta.slice(0, 4));

  const ventas = [];
  for (const t of await tablasDe(p.schema, 'i22_ventas_detalladas')) {
    if (t.anio < a0 || t.anio > a1) continue;
    ventas.push(...await leer(p.schema, t, p.pdv, 'fecha', desde, hasta));
  }
  const pagos = [];
  let tablas72 = await tablasDe(p.schema, 'i72_cta_cte_por_comprobante');
  if (!tablas72.length) tablas72 = await tablasDe(p.schema, 'i71_cta_por_comprobante'); // nombre con que lo sube el kit hoy
  for (const t of tablas72) {
    if (t.anio > a1) continue;
    pagos.push(...await leer(p.schema, t, p.pdv, 'fechacob', desde, hasta));
  }
  return { pdv: p.pdv, desde, hasta, ventas, pagos };
}

module.exports = { pdvDeSucursal, validarRango, estado, traer };
