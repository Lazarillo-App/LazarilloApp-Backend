// Portado de lazarillo_gestion/lib/cta-cte/estado.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Estado de pago de un comprobante del 14 cruzado con el informe 80.
// Puro (sin Prisma): lo usan el semáforo de Detalle de compras y la cuenta
// corriente del proveedor.

// null = no lleva estado (sin comprobante, o número interno E/G de un gasto
// vario: en MaxiRest se carga siempre con su pago).
function estadoPago(d, desdeCobertura) {
  const c = d.comprobante?.trim().toUpperCase();
  if (!c || c.startsWith("E") || c.startsWith("G")) return null;
  if (c.startsWith("N")) return "nc";
  if (d.fecha && d.fecha < desdeCobertura && Math.abs(d.pagado) < 0.5) return "sin-datos";
  const saldo = d.total - d.pagado;
  if (Math.abs(d.pagado) > 0.5 && Math.abs(saldo) <= 1) return "paga";
  if (Math.abs(d.pagado) > 0.5) return "parcial";
  if (Math.abs(d.total) <= 1) return "paga";
  return d.pagoAutomatico ? "auto" : "impaga";
}

const ETIQUETA_ESTADO = {
  paga: "Paga",
  parcial: "Parcial",
  impaga: "Impaga",
  auto: "Pago automático",
  nc: "Nota de crédito",
  "sin-datos": "Sin datos de pago",
};

// Color del punto del semáforo (Tailwind).
const PUNTO_ESTADO = {
  paga: "bg-zinc-300 dark:bg-zinc-600",
  parcial: "bg-amber-500",
  impaga: "bg-red-600",
  auto: "bg-zinc-300 dark:bg-zinc-600",
  nc: "bg-sky-400",
  "sin-datos": "bg-transparent border border-zinc-300 dark:border-zinc-600",
};

const CHIP_ESTADO = {
  paga: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  parcial: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  impaga: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  auto: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  nc: "bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300",
  "sin-datos": "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

// Clave de comprobante dentro de un PDV (en el 14 una factura viene en varias filas).
const claveComprobante = (pdvId, comprobante, codigo) =>
  pdvId != null && comprobante && codigo ? `${pdvId}|${comprobante}|${codigo}` : null;

function filtrarPorPeriodo (l, p) {
  return p.modo === "todo" ? l : l.filter((f) => f.fecha.startsWith(String(p.anio)));
}

// Totales de la cuenta corriente: el saldo cuenta solo lo que es deuda real.
function totalesCtaCte(l) {
  let total = 0, pagado = 0, saldo = 0, impagas = 0;
  for (const f of l) {
    total += f.total;
    pagado += f.pagado;
    if (f.estado === "impaga" || f.estado === "parcial") { saldo += f.total - f.pagado; impagas++; }
  }
  return { total, pagado, saldo, impagas };
}

module.exports = { estadoPago, ETIQUETA_ESTADO, PUNTO_ESTADO, CHIP_ESTADO, claveComprobante, filtrarPorPeriodo, totalesCtaCte };
