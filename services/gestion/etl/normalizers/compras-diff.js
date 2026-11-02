// Portado de lazarillo_gestion/lib/etl/normalizers/compras-diff.ts (TypeScript → JavaScript, misma lógica).
'use strict';



function fechaIgual(a, b) {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

// Compara los 13 campos ERP-controlados de una compra — los mismos que hoy se
// sobreescriben sin condición en el ON CONFLICT de normalizeCompras (ver
// compras.ts). Usada para decidir si una compra ya distribuida necesita
// recalcular sus distribuciones tras una reimportación (spec Apertura de
// Gastos, sección 6/10.3 — "todos los campos ERP-controlados", no solo
// importe). Los campos decimal (importe/impInt/per1/2/3) deben venir ya
// canonicalizados por canonicalDecimal (compra-identity.ts) en ambos lados —
// esta función solo compara, no canonicaliza (evita hacerlo dos veces si el
// caller ya lo hizo para otro propósito, ej. el hash de identidad).
function camposErpCambiaron(anterior, nuevo) {
  return (
    anterior.codCga !== nuevo.codCga ||
    anterior.concepto !== nuevo.concepto ||
    !fechaIgual(anterior.fecha, nuevo.fecha) ||
    anterior.codigo !== nuevo.codigo ||
    anterior.proveedor !== nuevo.proveedor ||
    anterior.detalle !== nuevo.detalle ||
    anterior.observac !== nuevo.observac ||
    anterior.importe !== nuevo.importe ||
    anterior.impInt !== nuevo.impInt ||
    anterior.imputac !== nuevo.imputac ||
    anterior.per1 !== nuevo.per1 ||
    anterior.per2 !== nuevo.per2 ||
    anterior.per3 !== nuevo.per3
  );
}

module.exports = { camposErpCambiaron };
