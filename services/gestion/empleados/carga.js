// Portado de lazarillo_gestion/lib/empleados/carga.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { z } = require('zod');

// Carga de EMPLEADOS en el Panel (Diego 28/10/2026). Puro (sin Prisma): lo usan la ruta y los tests.
//
// SUELDO: empleado → período + fecha de pago (hoy por defecto) → primero el TOTAL y después la
// apertura por concepto de personal (tiene que sumar exacto); cada concepto con una o varias formas
// de pago. Los ADELANTOS del período ya cargados se descuentan: son una "forma de pago" más
// ("Adelantos") que no genera filas nuevas, porque el adelanto ya es un gasto del período.
// ADELANTO: concepto fijo "Adelanto Sueldo", va a la cuenta del empleado en el período.
// PDV: la regla de apertura del empleado; si se cambia en la carga, aplica sobre el total
// (todos los conceptos) y las filas quedan repartidas y bloqueadas, como una factura con reparto.
//
// Las filas se guardan como los sueldos de MaxiRest (sin comprobante, con código y nombre del
// empleado, período y fecha de pago): la Económica las cuenta por período y la Financiera por
// fecha de pago, y la apertura por empleado las reparte igual.

const MEDIO_ADELANTOS = "Adelantos";
const r2 = (n) => Math.round(n * 100) / 100;
const iguales = (a, b) => Math.abs(a - b) < 0.005;

const pagoSchema = z.object({ medio: z.string().trim().min(1).max(40), importe: z.number().positive().max(1e12) });
const conceptoSchema = z.object({
  conceptoCodigo: z.string().trim().min(1).max(20),
  importe: z.number().positive().max(1e12),
  pagos: z.array(pagoSchema).min(1).max(10),
});
const repartoSchema = z.array(z.object({ puntoDeVentaId: z.number().int(), pct: z.number().min(0).max(100) })).max(10);

const cargaEmpleadoSchema = z.discriminatedUnion("tipo", [
  z.object({
    tipo: z.literal("sueldo"),
    pdvId: z.number().int(),
    codigo: z.string().trim().min(1).max(20),
    periodo: z.string().regex(/^\d{4}-\d{2}$/),
    fechaPago: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    total: z.number().positive().max(1e12),
    conceptos: z.array(conceptoSchema).min(1).max(20),
    reparto: repartoSchema.nullish(),
    forzar: z.boolean().optional(),
  }),
  z.object({
    tipo: z.literal("adelanto"),
    pdvId: z.number().int(),
    codigo: z.string().trim().min(1).max(20),
    periodo: z.string().regex(/^\d{4}-\d{2}$/),
    fechaPago: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    importe: z.number().positive().max(1e12),
    medio: z.string().trim().min(1).max(40),
    observacion: z.string().trim().max(200).nullish(), // Diego 12/11/2026: motivo del adelanto
    reparto: repartoSchema.nullish(),
    forzar: z.boolean().optional(),
  }),
]);

/** Problemas de una carga de sueldo (vacío = se puede guardar). `adelantosPeriodo`: lo adelantado en el período. */
function validarSueldo(c, adelantosPeriodo) {
  const out = [];
  const sumaConceptos = r2(c.conceptos.reduce((s, x) => s + x.importe, 0));
  if (!iguales(sumaConceptos, c.total)) out.push(`Los conceptos suman $ ${fmt(sumaConceptos)} y el total es $ ${fmt(c.total)}: tienen que dar exacto.`);
  c.conceptos.forEach((x, i) => {
    const pagos = r2(x.pagos.reduce((s, p) => s + p.importe, 0));
    if (!iguales(pagos, x.importe)) out.push(`Concepto ${i + 1}: las formas de pago suman $ ${fmt(pagos)} y el concepto es $ ${fmt(x.importe)}.`);
  });
  const usados = r2(c.conceptos.flatMap((x) => x.pagos).filter((p) => p.medio === MEDIO_ADELANTOS).reduce((s, p) => s + p.importe, 0));
  if (!iguales(usados, r2(adelantosPeriodo))) {
    out.push(adelantosPeriodo > 0
      ? `En el período hay $ ${fmt(adelantosPeriodo)} de adelantos: tienen que descontarse (forma de pago "Adelantos"), y hay $ ${fmt(usados)}.`
      : `No hay adelantos cargados en el período: sacá la forma de pago "Adelantos".`);
  }
  if (adelantosPeriodo > c.total + 0.005) out.push(`Los adelantos del período ($ ${fmt(adelantosPeriodo)}) superan el sueldo.`);
  const rep = (c.reparto ?? []).filter((x) => x.pct > 0);
  if (rep.length >= 2 && !iguales(rep.reduce((s, x) => s + x.pct, 0), 100)) out.push("El reparto por PDV tiene que sumar 100%.");
  return out;
}

/** Reparte un importe en partes que suman exacto (el redondeo va a la última). */
function partir(importe, fracs) {
  const out = fracs.map((f) => r2(importe * f));
  out[out.length - 1] = r2(importe - out.slice(0, -1).reduce((s, x) => s + x, 0));
  return out;
}

/** Filas de compras de una carga: una por concepto × forma de pago (sin "Adelantos"), repartidas si hay reparto. */
function filasEmpleado(id, c) {
  const items = c.tipo === "sueldo"
    ? c.conceptos.flatMap((x) => x.pagos.filter((p) => p.medio !== MEDIO_ADELANTOS).map((p) => ({ concepto: x.conceptoCodigo, medio: p.medio, importe: p.importe })))
    : [{ concepto: "", medio: c.medio, importe: c.importe }];
  const rep = (c.reparto ?? []).filter((x) => x.pct > 0);
  const partes = rep.length >= 2 ? rep : [{ puntoDeVentaId: c.pdvId, pct: 100 }];
  const suma = partes.reduce((s, x) => s + x.pct, 0);
  const fracs = partes.map((x) => x.pct / suma);
  const out = [];
  items.forEach((it, i) => {
    partir(it.importe, fracs).forEach((imp, k) => {
      if (Math.abs(imp) < 0.005) return;
      out.push({ rowId: `emp-${id}-${i}-${k}`, puntoDeVentaId: partes[k].puntoDeVentaId, conceptoCodigo: it.concepto, medio: it.medio, importe: imp, bloqueada: partes.length >= 2 });
    });
  });
  return out;
}

function fmt(n) {
  return n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { MEDIO_ADELANTOS, cargaEmpleadoSchema, validarSueldo, filasEmpleado };
