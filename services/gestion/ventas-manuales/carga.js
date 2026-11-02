// Portado de lazarillo_gestion/lib/ventas-manuales/carga.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { z } = require('zod');

// Ingresos cargados a mano en Ventas (Diego 29/10/2026): facturas que no están en el PDV o días
// en que el PDV falló (Comercio, enero 2026). Se guardan en la misma tabla `ventas` para que
// todo el Panel los sume igual, pero se distinguen por:
//   - rowId "man-…" → el import de MaxiRest nunca los reusa ni los quita;
//   - codCobro "MAN" → en Ventas salen en su propia fila, marcada MANUAL.
// Tipo y forma de cobro son opcionales.
const PREFIJO_MANUAL = "man-";
const COD_COBRO_MANUAL = "MAN";
const esManual = (rowId) => rowId.startsWith(PREFIJO_MANUAL);

const texto = (max) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

const itemSchema = z.object({
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  importe: z.number().finite().refine((n) => Math.abs(n) >= 0.01, "El importe no puede ser 0").refine((n) => Math.abs(n) < 1e12),
  tipo: texto(20),
  cobro: texto(40),
  detalle: texto(120),
  cliente: texto(80),
});

const altaSchema = z.object({
  pdvId: z.number().int().positive(),
  items: z.array(itemSchema).min(1).max(400),
  forzar: z.boolean().optional(),
});

/** Clave para no cargar dos veces el mismo ingreso manual. */
function claveIngreso(x) {
  const t = (s) => (s ?? "").trim().toUpperCase();
  return [x.fecha, t(x.tipo), t(x.cobro), (Math.round(x.importe * 100) / 100).toFixed(2)].join("|");
}

/** Grilla día × columna → ítems (solo las celdas con importe). */
function itemsDeGrilla(modo, celdas, parse, detalle) {
  const out = [];
  for (const fecha of Object.keys(celdas).sort()) {
    for (const [col, valor] of Object.entries(celdas[fecha])) {
      const importe = Math.round(parse(valor) * 100) / 100;
      if (!Number.isFinite(importe) || Math.abs(importe) < 0.01) continue;
      out.push({
        fecha, importe, detalle, cliente: null,
        tipo: modo === "tipo" ? col : null,
        cobro: modo === "cobro" ? col : null,
      });
    }
  }
  return out;
}

/** Días entre dos fechas ISO (incluidas), tope 62. */
function diasEntre(desde, hasta) {
  const out = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta) || hasta < desde) return out;
  for (let t = Date.parse(`${desde}T00:00:00Z`); t <= Date.parse(`${hasta}T00:00:00Z`) && out.length < 62; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

module.exports = { PREFIJO_MANUAL, COD_COBRO_MANUAL, esManual, itemSchema, altaSchema, claveIngreso, itemsDeGrilla, diasEntre };
