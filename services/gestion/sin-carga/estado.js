// Portado de lazarillo_gestion/lib/sin-carga/estado.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// "Sin carga" (Diego, 28/10/2026): gastos que se cargan todos los meses y en un mes
// todavía no están — como Impagas, pero de lo que falta cargar. Un gasto es "de todos
// los meses" si su proveedor (o su concepto de caja, en los gastos varios) aparece en
// RECURRENTE_MIN de los últimos RECURRENTE_VENTANA meses del PDV. Solo rubros visibles en
// el cuadro de Compras (Diego). Los chicos (< CHICO) se ocultan de entrada.

const RECURRENTE_MIN = 3;
const RECURRENTE_VENTANA = 4;
const MESES_A_MIRAR = 3; // el mes en curso y los dos anteriores
const CHICO = 1000;

/** Clave de descarte: "Ya no va" = la clave sola; "Este mes no" = clave + "@YYYY-MM". */
const claveDescarte = (clave, mes) => (mes ? `${clave}@${mes}` : clave);
const mesDeDescarte = (clave) => (clave.includes("@") ? clave.split("@")[1] : null);

const p2 = (n) => String(n).padStart(2, "0");

/** Día en que suele estar cargado: el día habitual del mes (o del siguiente si va a mes vencido). */
function venceEl(mes, dia, vencido) {
  let [y, m] = mes.split("-").map(Number);
  if (vencido) { m += 1; if (m > 12) { m = 1; y += 1; } }
  const ult = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${p2(m)}-${p2(Math.min(Math.max(Math.round(dia) || 1, 1), ult))}`;
}

/** Atrasado: ya pasó el día en que suele estar cargado. */
function estaAtrasado(vence, hoy) {
  return hoy > vence;
}

/** Meses a mirar: el de hoy y los anteriores, como "YYYY-MM-01". */
function mesesObjetivo(hoy, n = MESES_A_MIRAR) {
  const [y, m] = hoy.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const t = y * 12 + (m - 1) - i;
    return `${Math.floor(t / 12)}-${p2((t % 12) + 1)}-01`;
  });
}

// Mantenimiento en meses que ya pasaron (Diego 28/10): no se espera, salvo que sea de TODOS los
// meses del año (estuvo en cada uno de los últimos 12 meses con datos del PDV).
const RUBROS_SOLO_FIJOS = ["mantenimiento"];
function esperadoEnMesCerrado(rubro, mes, mesActual, mesesConGasto, mesesConDatos) {
  if (mes >= mesActual) return true;
  if (!RUBROS_SOLO_FIJOS.includes(rubro.trim().toLowerCase())) return true;
  return mesesConDatos > 0 && mesesConGasto >= mesesConDatos;
}

/** "Qué le compro" (Diego 28/10): su insumo más comprado + el concepto de ese insumo; si no tiene
 * insumos, su concepto de mayor importe. */
function resumenCompra(insumos, conceptos) {
  const ins = [...insumos].filter((x) => x.txt).sort((a, b) => b.imp - a.imp)[0];
  if (ins) return ins.obs ? `${ins.txt} · ${ins.obs}` : ins.txt;
  const con = [...conceptos].filter((x) => x.txt).sort((a, b) => b.imp - a.imp)[0];
  return con ? con.txt : null;
}

function totales(items, conChicos) {
  const vis = conChicos ? items : items.filter((x) => x.ultimo >= CHICO);
  return { n: vis.length, total: vis.reduce((s, x) => s + x.ultimo, 0), visibles: vis };
}

/**
 * Saca un gasto de la respuesta de /api/sin-carga en el momento (Diego 29/10: "Ya no va" tardaba
 * en sacarlo — esperaba a que se recalculara todo en el servidor). "Ya no va" (mes null) lo saca
 * de todos los meses; "Este mes no", solo de ese mes. El servidor confirma después.
 */
function sinElGasto (data, clave, mes) {
  if (!data) return data;
  return { ...data, meses: data.meses.map((m) => (mes && m.mes !== mes ? m : { ...m, items: m.items.filter((x) => x.clave !== clave) })) };
}

module.exports = { RECURRENTE_MIN, RECURRENTE_VENTANA, MESES_A_MIRAR, CHICO, claveDescarte, mesDeDescarte, venceEl, estaAtrasado, mesesObjetivo, RUBROS_SOLO_FIJOS, esperadoEnMesCerrado, resumenCompra, totales, sinElGasto };
