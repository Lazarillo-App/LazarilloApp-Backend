// Portado de lazarillo_gestion/lib/medios-pago/abm.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { z } = require('zod');

// Gestor de medios de pago (Diego, 27/10/2026): una sola lista para todo el Panel
// (Impagas, cuenta corriente, carga de factura y Gastos Varios), con alta, baja y
// modificación. Los pagos guardan el NOMBRE del medio; renombrar actualiza los pagos.
const TIPOS_MEDIO = [
  { valor: "caja", etiqueta: "Caja" },
  { valor: "banco", etiqueta: "Banco" },
  { valor: "tarjeta", etiqueta: "Tarjeta" },
  // Descuento (Diego 12/11/2026): salda deuda sin mover plata. Viene en todos los negocios.
  { valor: "descuento", etiqueta: "Descuento" },
  { valor: "otro", etiqueta: "Otro" },
];

const etiquetaTipoMedio = (t) => TIPOS_MEDIO.find((x) => x.valor === t)?.etiqueta ?? "Otro";

const medioSchema = z.object({
  nombre: z.string().trim().min(1, "Poné un nombre").max(40),
  tipo: z.enum(["caja", "banco", "tarjeta", "descuento", "otro"]),
  pideId: z.boolean(),
  activo: z.boolean().optional(),
});

const mismoNombre = (a, b) => a.trim().toLocaleLowerCase("es") === b.trim().toLocaleLowerCase("es");

// Medios que se ofrecen en un selector: los activos y, si se está editando un pago
// con un medio ya desactivado, también ese (para no perderlo).
function mediosParaElegir(medios, actual) {
  const lista = (medios ?? []).filter((m) => m.activo || (actual != null && m.nombre === actual));
  return [...lista].sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre, "es"));
}

module.exports = { TIPOS_MEDIO, etiquetaTipoMedio, medioSchema, mismoNombre, mediosParaElegir };
