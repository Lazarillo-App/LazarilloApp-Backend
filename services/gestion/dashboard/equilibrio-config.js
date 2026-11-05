// Portado de lazarillo_gestion/lib/dashboard/equilibrio-config.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Configuración de qué gastos son VARIABLES para el punto de equilibrio (Diego 30/10/2026): por
// rubro o por concepto (el concepto manda sobre su rubro); lo que no figura es fijo. Se edita desde
// el ⚙ de la fila "Punto de equilibrio" y desde Conceptos de caja (tabla equilibrio_variables).

                                                                                           // null = sin marca

const claveVar = (tipo, codigo) => `${tipo}:${String(codigo).trim()}`;

function mapaVariables(vs) {
  return new Map(vs.map((v) => [claveVar(v.tipo, v.codigo), Number(v.pct)]));
}

/** % variable de un concepto: el suyo si tiene marca; si no, el de su rubro; si no, 0 (fijo). */
function pctEfectivo(m, rubroCodigo, concepto) {
  return m.get(claveVar("concepto", concepto)) ?? (rubroCodigo != null ? m.get(claveVar("rubro", rubroCodigo)) : undefined) ?? 0;
}

/** Cuánto de los gastos es variable con esa configuración (sobre el promedio o el mes de referencia). */
function variableDe(gastos, m, campo) {
  return gastos.reduce((s, g) => s + g[campo] * pctEfectivo(m, g.rubroCodigo, g.codigo) / 100, 0);
}

function etiquetaPct(p) {
  if (p == null || p === 0) return "Fijo";
  if (p === 100) return "Variable";
  return `${p.toLocaleString("es-AR", { maximumFractionDigits: 2 })}%`;
}

/** Lo que cambió entre la configuración guardada y el borrador (para un solo PUT). */
function cambiosEntre(orig, draft) {
  const out = [];
  const parse = (k) => { const i = k.indexOf(":"); return { tipo: k.slice(0, i), codigo: k.slice(i + 1) }; };
  for (const [k, v] of draft) if (orig.get(k) !== v) out.push({ ...parse(k), pct: v });
  for (const k of orig.keys()) if (!draft.has(k)) out.push({ ...parse(k), pct: null });
  return out;
}

/** Valida un cambio que llega por la API. */
function cambioValido(c) {
  if (!c || typeof c !== "object") return false;
  const x = c;
  return (x.tipo === "rubro" || x.tipo === "concepto")
    && typeof x.codigo === "string" && x.codigo.trim() !== "" && x.codigo.length <= 20
    && (x.pct === null || (typeof x.pct === "number" && Number.isFinite(x.pct) && x.pct >= 0 && x.pct <= 100));
}

module.exports = { claveVar, mapaVariables, pctEfectivo, variableDe, etiquetaPct, cambiosEntre, cambioValido };
