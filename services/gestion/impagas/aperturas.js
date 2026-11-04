// Portado de lazarillo_gestion/lib/impagas/aperturas.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Aperturas entre PDV en la vista Impagas (lógica pura, la usan el modal y la API).
//
// Cuando un gasto de un PDV se apertura a otro, el PDV destino le debe su % al
// PDV origen: el origen administra el fondo (pagó al proveedor, sueldos,
// impuestos) y es a quien hay que pagarle. No importa si el origen ya le pagó
// al proveedor. Cada "movimiento" es una fila de compras aperturada al destino.
// Los pagos al PDV origen se registran en Lazarillo y quedan imputados a
// movimientos concretos (aplicaciones): "Saldar" imputa el saldo entero de los
// elegidos; un pago libre se imputa a lo más viejo primero, el último puede
// quedar parcial y lo que sobra queda a cuenta.

// Número visible de la orden de pago: "OP 0012".
const numeroOP = (id) => `OP ${String(id).padStart(4, "0")}`;

// Medios de pago: ya no es una lista fija, ver lib/medios-pago (gestor, 27/10/2026).

const saldoMov = (m) =>
  Math.max(0, m.importe - m.aplicado);

function ordenarMovimientos (l) {
  return [...l].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.key.localeCompare(b.key));
}

// Imputa un importe a lo más viejo primero. Devuelve las aplicaciones y lo que sobra (a cuenta).
function imputarFifo(
  movs,
  importe
) {
  let resto = redondear(importe);
  const aplicaciones = [];
  for (const m of ordenarMovimientos(movs)) {
    if (resto <= 0) break;
    const s = redondear(saldoMov(m));
    if (s <= 0) continue;
    const a = Math.min(s, resto);
    aplicaciones.push({ key: m.key, importe: a });
    resto = redondear(resto - a);
  }
  return { aplicaciones, sobrante: resto };
}

const redondear = (n) => Math.round(n * 100) / 100;

// Pago sobre movimientos elegidos (un mes, un empleado o una selección):
// sin importe se salda el saldo entero de cada uno; con importe se imputa a lo
// elegido del más viejo al más nuevo (el último puede quedar parcial) y lo que
// sobra queda a cuenta, sin asociar a ningún movimiento.
function imputarElegidos(
  movs,
  keys,
  importe
) {
  const elegidos = new Set(keys);
  const l = movs.filter((m) => elegidos.has(m.key));
  if (importe === undefined) {
    const aplicaciones = ordenarMovimientos(l)
      .map((m) => ({ key: m.key, importe: redondear(saldoMov(m)) }))
      .filter((a) => a.importe > 0);
    return { aplicaciones, sobrante: 0 };
  }
  return imputarFifo(l, importe);
}

// Disponible de una orden de pago (lo que quedó a cuenta, sin imputar).
const disponibleOP = (p) => redondear(Math.max(0, p.importe - p.aplicado));

// Al editar el importe de una orden de pago: se vuelve a imputar primero a los
// mismos movimientos que tenía (del más viejo al más nuevo) y, si sobra, a lo
// más viejo pendiente; lo que no entra queda a cuenta.
function reimputar(
  movs,
  antes,
  importe
) {
  const previos = new Set(antes);
  const r1 = imputarFifo(movs.filter((m) => previos.has(m.key)), importe);
  const r2 = imputarFifo(movs.filter((m) => !previos.has(m.key)), r1.sobrante);
  return { aplicaciones: [...r1.aplicaciones, ...r2.aplicaciones], sobrante: r2.sobrante };
}

const aCuenta = (d) =>
  redondear(d.pagos.reduce((s, p) => s + Math.max(0, p.importe - p.aplicado), 0));

const saldoDeuda = (d) =>
  redondear(Math.max(0, d.movimientos.reduce((s, m) => s + saldoMov(m), 0) - aCuenta(d)));

// Para mostrar: el mes más nuevo primero y, adentro, el movimiento más nuevo primero.
function porMes(movs) {
  const m = new Map ();
  for (const x of ordenarMovimientos(movs).reverse()) {
    const k = x.fecha.slice(0, 7);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return [...m.entries()].map(([mes, l]) => ({
    mes, movimientos: l,
    total: redondear(l.reduce((s, x) => s + x.importe, 0)),
    saldo: redondear(l.reduce((s, x) => s + saldoMov(x), 0)),
  }));
}

// Dentro de un mes: los sueldos de un mismo empleado (liquidación, presentismo,
// feriados, adelantos…) van juntos en una fila por empleado; el resto queda
// movimiento por movimiento. Mantiene el orden recibido (más nuevo primero).

function agruparEmpleados(movs) {
  const out = [];
  const porNombre = new Map ();
  for (const m of movs) {
    if (!m.esEmpleado) { out.push({ tipo: "mov", mov: m }); continue; }
    let g = porNombre.get(m.proveedor);
    if (!g) {
      g = { tipo: "empleado", nombre: m.proveedor, movimientos: [], total: 0, saldo: 0, aplicado: 0 };
      porNombre.set(m.proveedor, g);
      out.push(g);
    }
    g.movimientos.push(m);
    g.total = redondear(g.total + m.importe);
    g.saldo = redondear(g.saldo + saldoMov(m));
    g.aplicado = redondear(g.aplicado + m.aplicado);
  }
  return out;
}

// ── Deuda con un PDV agrupada por rubro ─────────────────────────────────────
// Cada rubro se ve como uno elija: por proveedor, por concepto o por empleado
// (por insumo, próximamente). Por defecto Personal va por empleado y el resto
// por concepto. Dentro de cada grupo, el movimiento más nuevo primero.
const MODOS_RUBRO = ["proveedor", "concepto", "empleado", "insumo"];

const ETIQUETA_MODO = {
  proveedor: "por proveedor", concepto: "por concepto", empleado: "por empleado", insumo: "por insumo",
};
const modoDefault = (rubro) => (/personal/i.test(rubro) ? "empleado" : "concepto");

// En "por empleado" los que no son sueldos (cargas sociales, gastos varios del
// personal) van por su concepto. "Por insumo" todavía no existe: va por concepto.
function claveGrupo(m, modo) {
  if (modo === "proveedor") return m.proveedor || "—";
  if (modo === "empleado" && m.esEmpleado) return m.proveedor || "—";
  return m.concepto || "Sin concepto";
}

function porRubro(movs, modos = {}) {
  const rubros = new Map ();
  for (const m of ordenarMovimientos(movs).reverse()) {
    const r = m.rubro || "Sin rubro";
    if (!rubros.has(r)) rubros.set(r, []);
    rubros.get(r).push(m);
  }
  const suma = (l, f) => redondear(l.reduce((s, x) => s + f(x), 0));
  return [...rubros.entries()].map(([rubro, l]) => {
    const modo = modos[rubro] ?? modoDefault(rubro);
    const g = new Map ();
    for (const m of l) {
      const k = claveGrupo(m, modo);
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(m);
    }
    const grupos = [...g.entries()].map(([clave, ms]) => ({
      clave, movimientos: ms, total: suma(ms, (x) => x.importe), saldo: suma(ms, saldoMov), aplicado: suma(ms, (x) => x.aplicado),
      esEmpleado: modo === "empleado" && ms.every((x) => x.esEmpleado),
    })).sort((a, b) => b.saldo - a.saldo || b.total - a.total || a.clave.localeCompare(b.clave));
    return { rubro, modo, grupos, movimientos: l, total: suma(l, (x) => x.importe), saldo: suma(l, saldoMov) };
  }).sort((a, b) => b.saldo - a.saldo || b.total - a.total || a.rubro.localeCompare(b.rubro));
}

// ID de transferencia: alfanumérico, sin espacios, hasta 100 caracteres (los
// bancos usan IDs largos, p. ej. 25). Se guarda tal cual, en mayúsculas.
function normalizarReferencia(raw) {
  const v = raw.replace(/\s+/g, "").toUpperCase();
  return /^[A-Z0-9]{1,100}$/.test(v) ? v : null;
}

// ── Importe en formato moneda (es-AR): "$ 1.234.567,89" ──────────────────────
function parsearImporteAR(t) {
  const limpio = t.replace(/[^\d,]/g, "");
  if (!limpio) return null;
  const [ent, dec = ""] = limpio.split(",");
  const n = Number(`${ent || "0"}.${dec.slice(0, 2) || "0"}`);
  return Number.isFinite(n) ? n : null;
}

// Formatea mientras se tipea: miles con punto, coma decimal (máx. 2 decimales).
function formatearImporteAR(t) {
  const limpio = t.replace(/[^\d,]/g, "");
  if (!limpio) return "";
  const i = limpio.indexOf(",");
  const ent = (i >= 0 ? limpio.slice(0, i) : limpio).replace(/^0+(?=\d)/, "");
  const dec = i >= 0 ? "," + limpio.slice(i + 1).replace(/,/g, "").slice(0, 2) : "";
  return "$ " + (ent || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ".") + dec;
}

// Cursor del input de importe: al reformatear (puntos de miles) el cursor no
// debe saltar al final. Se cuentan los caracteres que importan (dígitos y la
// coma) antes del cursor y se lo vuelve a poner después de la misma cantidad.
const significativo = (c) => /[\d,]/.test(c);

function contarAntesDelCursor(texto, cursor) {
  let n = 0;
  for (let i = 0; i < Math.min(cursor, texto.length); i++) if (significativo(texto[i])) n++;
  return n;
}

function cursorTrasSignificativos(formateado, n) {
  if (n <= 0) {
    const i = formateado.search(/[\d,]/);
    return i < 0 ? formateado.length : i;
  }
  let c = 0;
  for (let i = 0; i < formateado.length; i++) {
    if (significativo(formateado[i]) && ++c === n) return i + 1;
  }
  return formateado.length;
}

const importeAInput = (n) =>
  formatearImporteAR(redondear(n).toFixed(2).replace(".", ",").replace(/,00$/, ""));

// % de la regla de apertura de un grupo: "15%" si todos iguales, "10–15%" si varía.
function rangoPorcentaje(movs) {
  const ps = movs.map((m) => m.porcentaje).filter((p) => Number.isFinite(p) && p > 0);
  if (!ps.length) return null;
  const fmt = (n) => `${Math.round(n * 10) / 10}`.replace(".", ",");
  const min = Math.min(...ps), max = Math.max(...ps);
  return Math.abs(max - min) < 0.05 ? `${fmt(min)}%` : `${fmt(min)}–${fmt(max)}%`;
}

// Tooltip del importe de un movimiento: la parte de este PDV sobre el total.
function textoParte(m, fmt) {
  const pct = `${Math.round(m.porcentaje * 10) / 10}`.replace(".", ",");
  return m.totalCompra && Math.abs(m.totalCompra) > 0.5
    ? `${fmt(m.importe)} de ${fmt(m.totalCompra)} (${pct}%)`
    : `${fmt(m.importe)} (${pct}%)`;
}

module.exports = { numeroOP, saldoMov, ordenarMovimientos, imputarFifo, redondear, imputarElegidos, disponibleOP, reimputar, aCuenta, saldoDeuda, porMes, agruparEmpleados, MODOS_RUBRO, ETIQUETA_MODO, modoDefault, porRubro, normalizarReferencia, parsearImporteAR, formatearImporteAR, contarAntesDelCursor, cursorTrasSignificativos, importeAInput, rangoPorcentaje, textoParte };
