// Portado de lazarillo_gestion/lib/dashboard/equilibrio.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Punto de equilibrio (Diego 30/10/2026): cuánto hay que vender para no perder.
//
// Los gastos se separan en VARIABLES (acompañan a la venta; por defecto Mercaderías, Otros gastos,
// Impuesto fiscal y los Feriados del personal — tabla equilibrio_variables) y FIJOS (el resto).
//   % variable = variables / ventas
//   equilibrio = fijos / (1 − % variable)
// Con los números del mismo mes, lo que queda de lo vendido arriba del equilibrio
// ((ventas − equilibrio) × (1 − % variable)) es exactamente el resultado: así se lee
// de dónde sale la ganancia sin confundir "arriba del equilibrio" con ganancia.

function equilibrioMes(ventas, egresos, variable) {
  if (!(ventas > 0)) return null;
  const pctVariable = Math.max(0, variable) / ventas;
  const fijos = egresos - variable;
  const queda = 1 - pctVariable;
  const equilibrio = queda > 0.02 ? fijos / queda : null;
  return { ventas, egresos, variable, pctVariable, fijos, equilibrio, diferencia: equilibrio == null ? 0 : ventas - equilibrio, queda };
}

/** % variable de los últimos meses cerrados (ponderado por ventas): para proyectar el mes en curso. */
function pctVariableReciente(meses) {
  const v = meses.filter((m) => m.ventas > 0);
  const ventas = v.reduce((s, m) => s + m.ventas, 0);
  return ventas > 0 ? v.reduce((s, m) => s + m.variable, 0) / ventas : null;
}

/** Mes en curso: equilibrio con los egresos proyectados y el % variable de los meses cerrados. */
function equilibrioProyectado(p

 ) {
  const base = equilibrioMes(p.ventasProy, p.egresosProy, p.pctVariable * p.ventasProy);
  if (!base) return null;
  const falta = base.equilibrio == null ? 0 : Math.max(0, base.equilibrio - p.facturado);
  return { ...base, facturado: p.facturado, diasRestantes: p.diasRestantes, falta, porDia: falta > 0 && p.diasRestantes > 0 ? falta / p.diasRestantes : null };
}

module.exports = { equilibrioMes, pctVariableReciente, equilibrioProyectado };
