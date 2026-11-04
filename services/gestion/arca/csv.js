// Portado de lazarillo_gestion/lib/arca/csv.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// CSV de "Mis Comprobantes" de ARCA (recibidos): separado por ";", números con coma decimal,
// primera fila de encabezados (Diego 28/10/2026). Se lee por nombre de columna, así si ARCA
// agrega o mueve columnas no se rompe.

// Tipos de comprobante de ARCA → etiqueta del Panel y si resta (NC).
const TIPOS = {
  1: { etiqueta: "FcA" }, 2: { etiqueta: "ND-A" }, 3: { etiqueta: "NC-A", nc: true },
  6: { etiqueta: "FcB" }, 7: { etiqueta: "ND-B" }, 8: { etiqueta: "NC-B", nc: true },
  11: { etiqueta: "FcC" }, 12: { etiqueta: "ND-C" }, 13: { etiqueta: "NC-C", nc: true },
  51: { etiqueta: "FcM" }, 53: { etiqueta: "NC-M", nc: true },
  81: { etiqueta: "Tique FcA" }, 82: { etiqueta: "Tique FcB" }, 83: { etiqueta: "Tique" },
  17: { etiqueta: "Liq. serv. públicos A" }, 18: { etiqueta: "Liq. serv. públicos B" },
};
const etiquetaTipo = (t) => TIPOS[t]?.etiqueta ?? `Tipo ${t}`;
const esNotaCredito = (t) => !!TIPOS[t]?.nc;
/** Tipo del modal de carga ("FcA", "FcB", "FcC", "NC-A", "Ticket") para precargar. */
function tipoModal(t) {
  if ([1, 51, 81].includes(t)) return "FcA";
  if ([6, 82].includes(t)) return "FcB";
  if ([11, 83].includes(t)) return "FcC";
  if ([3, 8, 13, 53].includes(t)) return "NC-A";
  return "FcA";
}

const soloDig = (s) => (s ?? "").replace(/\D/g, "");
const num = (s) => {
  const t = (s ?? "").trim();
  if (!t) return 0;
  const v = Number(t.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(v) ? v : 0;
};

function partir(linea) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') { if (q && linea[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ";" && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9%,]+/g, " ").trim();

function leerCsvArca(texto) {
  const lineas = texto.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lineas.length) return { comprobantes: [], errores: ["El archivo está vacío."] };
  const cab = partir(lineas[0]).map(norm);
  const col = (...nombres) => cab.findIndex((c) => nombres.some((n) => c === norm(n)));
  const ix = {
    fecha: col("Fecha de Emisión", "Fecha"), tipo: col("Tipo de Comprobante", "Tipo"), pv: col("Punto de Venta"),
    nro: col("Número Desde", "Número"), cae: col("Cód. Autorización", "CAE"), cuitE: col("Nro. Doc. Emisor"),
    emisor: col("Denominación Emisor"), cuitR: col("Nro. Doc. Receptor"), tc: col("Tipo Cambio"), moneda: col("Moneda"),
    neto: col("Imp. Neto Gravado Total"), noGrav: col("Imp. Neto No Gravado"), exento: col("Imp. Op. Exentas"),
    otros: col("Otros Tributos"), iva: col("Total IVA"), total: col("Imp. Total"),
  };
  const faltan = Object.entries({ fecha: ix.fecha, tipo: ix.tipo, pv: ix.pv, nro: ix.nro, cuitE: ix.cuitE, total: ix.total }).filter(([, v]) => v < 0).map(([k]) => k);
  if (faltan.length) return { comprobantes: [], errores: [`No parece el CSV de Mis Comprobantes de ARCA (faltan columnas: ${faltan.join(", ")}).`] };
  const comprobantes = []; const errores = [];
  lineas.slice(1).forEach((l, i) => {
    const c = partir(l);
    const fecha = c[ix.fecha]; const tipo = Number(c[ix.tipo]); const pv = Number(c[ix.pv]); const nro = Number(soloDig(c[ix.nro]));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha ?? "") || !tipo || !Number.isFinite(pv) || !nro || !soloDig(c[ix.cuitE])) { errores.push(`Fila ${i + 2}: no se pudo leer.`); return; }
    const tc = ix.tc >= 0 ? num(c[ix.tc]) || 1 : 1;
    const moneda = ix.moneda >= 0 ? c[ix.moneda] || null : null;
    // Montos en pesos: si viene en otra moneda, se pasa con el tipo de cambio del comprobante.
    const f = moneda && moneda !== "$" && moneda.toUpperCase() !== "PES" ? tc : 1;
    comprobantes.push({
      cuitReceptor: soloDig(ix.cuitR >= 0 ? c[ix.cuitR] : ""), cuitEmisor: soloDig(c[ix.cuitE]), emisor: ix.emisor >= 0 ? c[ix.emisor] || null : null,
      tipo, puntoVenta: pv, numero: nro, fecha, cae: ix.cae >= 0 ? c[ix.cae] || null : null, moneda, tipoCambio: tc,
      neto: num(c[ix.neto]) * f, noGravado: ix.noGrav >= 0 ? num(c[ix.noGrav]) * f : 0, exento: ix.exento >= 0 ? num(c[ix.exento]) * f : 0,
      otrosTributos: ix.otros >= 0 ? num(c[ix.otros]) * f : 0, iva: ix.iva >= 0 ? num(c[ix.iva]) * f : 0, total: num(c[ix.total]) * f,
    });
  });
  return { comprobantes, errores };
}

module.exports = { etiquetaTipo, esNotaCredito, tipoModal, leerCsvArca };
