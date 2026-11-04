// Portado de lazarillo_gestion/lib/apertura/cascada.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { parsearEntidadIdProveedorTexto } = require('../proveedor-entidad-id');

// Lo mínimo de una compra que hace falta para saber qué reglas podrían
// reclamarla — mismas columnas que condicionMatchNivel (motor.ts) compara.

// Reduce la cascada tras eliminar/editar una regla: en vez de reaplicar las
// ~200 reglas activas, solo hacen falta las que podrían reclamar las compras
// recién liberadas. Es un prefiltro: la query de aplicarRegla sigue siendo la
// que decide (vigencia, origen, esDistribuido), así que incluir una regla de
// más es inofensivo — dejar una afuera dejaría una compra sin distribuir sin
// ningún aviso. Por eso replica el matching de condicionMatchNivel sin
// relajarlo ni endurecerlo.
function seleccionarReglasCandidatas (reglas, compras) {
  if (compras.length === 0) return [];

  const rowIds = new Set ();
  const conceptos = new Set ();
  const proveedorIds = new Set ();
  // nombre normalizado -> códigos presentes; solo compras SIN proveedorId real
  // (la regla de texto exige proveedorId IS NULL).
  const codigosPorNombre = new Map ();

  for (const c of compras) {
    rowIds.add(c.rowId);
    if (c.conceptoEfectivo != null) conceptos.add(c.conceptoEfectivo);
    if (c.proveedorId != null) {
      proveedorIds.add(String(c.proveedorId));
    } else if (c.proveedorTextoNormalizado != null) {
      const codigos = codigosPorNombre.get(c.proveedorTextoNormalizado) ?? new Set ();
      codigos.add(c.codigo);
      codigosPorNombre.set(c.proveedorTextoNormalizado, codigos);
    }
  }

  const matchea = (regla) => {
    if (regla.nivel === "registro") return rowIds.has(regla.entidadId);
    if (regla.nivel === "concepto") return conceptos.has(regla.entidadId);
    const texto = parsearEntidadIdProveedorTexto(regla.entidadId);
    if (texto === null) return proveedorIds.has(regla.entidadId);
    const codigos = codigosPorNombre.get(texto.normalizado);
    if (codigos === undefined) return false;
    return texto.codigo === null || codigos.has(texto.codigo);
  };

  return reglas.filter(matchea);
}

module.exports = { seleccionarReglasCandidatas };
