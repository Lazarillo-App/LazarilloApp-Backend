// Portado de lazarillo_gestion/lib/conceptos/abm.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { z } = require('zod');

// Conceptos propios de Lazarillo (Diego, 26/10/2026): códigos desde 1000 —
// MaxiRest llega al 999, así nunca chocan. Los menores a 1000 vienen de MaxiRest
// y por ahora no se modifican desde el Panel.
const CODIGO_MIN_LAZARILLO = 1000;

const esPropio = (codigo) => Number(codigo) >= CODIGO_MIN_LAZARILLO;

function proximoCodigoLazarillo(codigos) {
  let max = CODIGO_MIN_LAZARILLO - 1;
  for (const c of codigos) {
    const n = Number(c);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

// Tipos de concepto tal como los guarda MaxiRest.
const TIPOS_CONCEPTO = [
  { valor: "-", etiqueta: "Egreso" },
  { valor: "+", etiqueta: "Ingreso" },
  { valor: "E", etiqueta: "Empleados" },
];

const etiquetaTipo = (t) => TIPOS_CONCEPTO.find((x) => x.valor === t)?.etiqueta ?? "—";

const conceptoPropioSchema = z.object({
  codigo: z.number().int().min(CODIGO_MIN_LAZARILLO).max(999_999).optional(),
  nombre: z.string().trim().min(1, "Poné un nombre").max(60),
  tipo: z.enum(["-", "+", "E"]),
  codRubro: z.string().trim().min(1, "Elegí un rubro").max(10),
  // Ya no se pide en pantalla (Diego, 26/10/2026); si no viene, no se toca.
  imputacion: z.string().trim().max(20).optional(),
  // Alta con "padrino": el concepto existente del que se copian tipo, rubro y
  // reglas de apertura (Diego, 26/10/2026).
  padrino: z.string().trim().min(1).max(10).optional(),
});

module.exports = { CODIGO_MIN_LAZARILLO, esPropio, proximoCodigoLazarillo, TIPOS_CONCEPTO, etiquetaTipo, conceptoPropioSchema };
