// Portado de lazarillo_gestion/lib/impagas/clasificar.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Vista Impagas: lógica pura (sin Prisma) — la usa el modal en el navegador.
//
// Un comprobante es "impago" si su total (el del informe 80 si existe, si no
// la suma del 14) menos lo pagado según el 80 no da cero. De esos, algunos
// quedan en la pestaña Excluidas por un MOTIVO:
//   - nc:    nota de crédito (no es algo a pagar; resta deuda).
//   - rubro: toda la factura (sin contar percepciones) es de rubros apagados en
//            "Rubros visibles en panel" — p. ej. Iva compensación.
//   - auto:  el proveedor está marcado "pago automático" (débito, retención).
// "Pasar a impagas" (forzada) le gana a cualquier motivo.

const MOTIVO_TITULO = {
  rubro: "Rubro oculto",
  auto: "Pago automático",
  nc: "Notas de crédito",
};

function esNotaCredito(f) {
  return f.comprobante.toUpperCase().startsWith("N");
}

function motivo(f) {
  if (f.forzada) return null;
  if (esNotaCredito(f)) return "nc";
  if (f.rubroOculto) return "rubro";
  if (f.pagoAutomatico) return "auto";
  return null;
}

const saldo = (f) => f.total - f.pagado;

function dias(fecha, hoy) {
  const [a, m, d] = fecha.split("-").map(Number);
  const f = Date.UTC(a, m - 1, d);
  const h = Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  return Math.round((h - f) / 86_400_000);
}

function separar(lista) {
  const impagas = [];
  const excluidas = [];
  for (const f of lista) (motivo(f) ? excluidas : impagas).push(f);
  return { impagas, excluidas };
}

// saldo desc = mayor primero; antigüedad desc = más vieja primero.
function compararGrupos(orden, dir) {
  const s = dir === "desc" ? 1 : -1;
  return (a, b) =>
    orden === "saldo"
      ? s * (b.saldo - a.saldo)
      : s * a.masVieja.localeCompare(b.masVieja) || b.saldo - a.saldo;
}

function agrupar(lista, orden, dir = "desc") {
  const m = new Map ();
  for (const f of lista) {
    let g = m.get(f.codPro);
    if (!g) {
      g = { clave: f.codPro, codPro: f.codPro, proveedor: f.proveedor, proveedorId: f.proveedorId, items: [], saldo: 0, masVieja: f.fecha };
      m.set(f.codPro, g);
    }
    g.items.push(f);
  }
  const grupos = [...m.values()];
  for (const g of grupos) {
    // Adentro del proveedor, la factura más nueva primero.
    g.items.sort((a, b) => b.fecha.localeCompare(a.fecha));
    g.saldo = g.items.reduce((s, f) => s + saldo(f), 0);
    g.masVieja = g.items[g.items.length - 1].fecha;
  }
  grupos.sort(compararGrupos(orden, dir));
  return grupos;
}

// Búsqueda tolerante: sin mayúsculas, acentos, espacios ni guiones, y con las
// letras repetidas colapsadas ("Zucala" encuentra "Zuccala"); los números quedan igual.
const normalizarBusqueda = (s) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s\-.]/g, "").replace(/([a-zñ])\1+/g, "$1");
const sinEspacios = normalizarBusqueda;

function filtrar(
  lista,
  { q, solo60, hoy }
) {
  const t = sinEspacios(q.trim());
  return lista.filter((f) =>
    (!solo60 || dias(f.fecha, hoy) <= 60) &&
    (!t || sinEspacios(f.proveedor).includes(t) || sinEspacios(f.comprobante).includes(t))
  );
}

const sumaSaldos = (l) => l.reduce((s, f) => s + saldo(f), 0);

// ── Formatos ────────────────────────────────────────────────────────────────
const fmtPesos = (n) => "$ " + Math.round(n).toLocaleString("es-AR");
const fmtMillones = (n) =>
  "$ " + (n / 1e6).toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " M";
function fmtFecha(f) {
  const [a, m, d] = f.split("-");
  return `${d}/${m}/${a}`;
}
// "A000300076701" → "A 0003-00076701"; "NC114008072025" → "NC 1140-08072025".
function fmtComprobante(c) {
  const letras = /^[A-Za-z]+/.exec(c)?.[0] ?? "";
  const resto = c.slice(letras.length);
  if (resto.length <= 4) return c;
  return `${letras} ${resto.slice(0, 4)}-${resto.slice(4)}`;
}

const tramoAntiguedad = (d) => (d <= 60 ? "reciente" : d <= 120 ? "media" : "vieja");

module.exports = { MOTIVO_TITULO, esNotaCredito, motivo, saldo, dias, separar, compararGrupos, agrupar, normalizarBusqueda, filtrar, sumaSaldos, fmtPesos, fmtMillones, fmtFecha, fmtComprobante, tramoAntiguedad };
