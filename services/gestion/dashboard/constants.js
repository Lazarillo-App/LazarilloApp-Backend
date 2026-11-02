// Portado de lazarillo_gestion/lib/dashboard/constants.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const MONTHS = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
];

const MONTH_IDXS = Array.from({ length: 12 }, (_, i) => i + 1);

// Fallback codes/nombres para registros sin categoría asignada
const SIN_RUBRO_CODE    = "__sin_rubro";
const SIN_RUBRO_NOMBRE  = "Sin Rubro";
const SIN_CONCEPTO_CODE  = "__sin_concepto";
const SIN_CONCEPTO_NOMBRE = "Sin Concepto";
const SIN_TIPO_CODE     = "__sin_tipo";
const SIN_TIPO_NOMBRE   = "Sin Tipo";
const SIN_COBRO_CODE    = "__sin_cobro";
const SIN_COBRO_NOMBRE  = "Sin Cobro";

// Rubro cuyos "proveedores" suelen ser en realidad personas de planilla con
// nombres ambiguos (ej. "Alejo" vs "Alejo Rodrigo", dos "Abril" con código
// distinto) — ahí se antepone el código de proveedor al nombre en la vista
// Compras x Proveedor. Ver docs/superpowers/specs/
// 2026-09-28-codigo-empleado-proveedor-design.md §2.3.
const RUBRO_GASTOS_EN_PERSONAL_CODIGO = "3";

// Campo booleano de RubroConceptoCaja que controla si un rubro se ve en cada vista del dashboard.
// Única fuente de verdad — no redeclarar este union en otros archivos.
const VISIBILIDAD_FIELDS = ["visibleEnDashboard", "visibleEnResultados"];

// "Sin Rubro" no es fila de rubros_concepto_caja, su toggle vive en sin_rubro_config. Estos defaults
// copian los de las columnas de los rubros reales y se usan si esa fila no existe (nunca ocultar en silencio).
const SIN_RUBRO_VISIBILIDAD_DEFAULT = {
  visibleEnDashboard: true,
  visibleEnResultados: false,
};

// Tope de filas del modal de detalle de compras. Un año completo sin filtro de rubro puede superar
// el tope viejo (2000); por encima de este, el modal avisa (hasMore) en vez de cortar callado.
const DETALLE_COMPRAS_LIMITE = 5000;

// Mismo criterio para el modal de detalle de ventas: antes cortaba en 2000 sin avisar.
const DETALLE_VENTAS_LIMITE = 5000;

module.exports = { MONTHS, MONTH_IDXS, SIN_RUBRO_CODE, SIN_RUBRO_NOMBRE, SIN_CONCEPTO_CODE, SIN_CONCEPTO_NOMBRE, SIN_TIPO_CODE, SIN_TIPO_NOMBRE, SIN_COBRO_CODE, SIN_COBRO_NOMBRE, RUBRO_GASTOS_EN_PERSONAL_CODIGO, VISIBILIDAD_FIELDS, SIN_RUBRO_VISIBILIDAD_DEFAULT, DETALLE_COMPRAS_LIMITE, DETALLE_VENTAS_LIMITE };
