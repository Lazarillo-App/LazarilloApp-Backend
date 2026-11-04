// Portado de lazarillo_gestion/lib/apertura/schemas.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { z } = require('zod');
const { validarSumaPorcentajes, encontrarDestinoDuplicado } = require('./validaciones');

const destinoSchema = z
  .object({
    localId: z.number().int().positive().nullable().optional(),
    puntoDeVentaId: z.number().int().nullable().optional(), // -negocio = la principal
    porcentaje: z.number().min(0).max(100),
  })
  .refine((d) => d.localId != null || d.puntoDeVentaId != null, {
    message: "Cada destino requiere localId o puntoDeVentaId",
  });

// Campos de vigencia sin destinos/confirmarHistorico — reusados por
// previewTotalQuerySchema (Fase C), que solo necesita saber SOBRE QUÉ
// PERÍODO previsualizar, no validar destinos ni pedir confirmación de
// histórico (esa confirmación es del paso de guardar, no de previsualizar).
const camposVigenciaFecha = {
  modo: z.enum(["historico", "entre_fechas", "desde_adelante", "desde_atras"]),
  fechaDesde: z.string().datetime({ offset: true }).nullable().optional(),
  fechaHasta: z.string().datetime({ offset: true }).nullable().optional(),
  extremosInclusivos: z.boolean().default(true),
};

// Origen (local/PDV). origenPuntoDeVentaId es obligatorio — una regla de
// origen "todo el local" no distingue de qué PDV vino cada compra, lo que
// generaba ambigüedad de negocio (ver sesión 19-sep-2026, reglas 64/108
// migradas/eliminadas por este motivo). origenLocalId queda opcional porque
// el servidor lo resuelve a partir del PDV (ver resolverLocalIdOrigen).
const camposOrigen = {
  origenLocalId: z.number().int().positive().nullable().optional(),
  origenPuntoDeVentaId: z.number().int().nullable().optional(), // -negocio = la principal
};

function validarOrigen(
  data,
  ctx
) {
  if (data.origenPuntoDeVentaId == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "La regla requiere un origen con punto de venta (origenPuntoDeVentaId)",
      path: ["origenPuntoDeVentaId"],
    });
  }
}

const camposVigencia = {
  ...camposVigenciaFecha,
  ...camposOrigen,
  destinos: z.array(destinoSchema).min(1),
  confirmarHistorico: z.boolean().optional(),
};

// Requisitos de fecha por modo — compartidos entre crear/editar regla (con
// destinos/confirmarHistorico, ver validarCuerpoRegla) y el preview de total
// (sin ellos, ver previewTotalQuerySchema más abajo).
function validarFechasPorModo(
  data,
  ctx
) {
  if (data.modo === "entre_fechas" && (!data.fechaDesde || !data.fechaHasta)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "modo 'entre_fechas' requiere fechaDesde y fechaHasta",
      path: ["fechaDesde"],
    });
  }
  if (data.modo === "desde_adelante" && !data.fechaDesde) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "modo 'desde_adelante' requiere fechaDesde", path: ["fechaDesde"] });
  }
  if (data.modo === "desde_atras" && !data.fechaHasta) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "modo 'desde_atras' requiere fechaHasta", path: ["fechaHasta"] });
  }
}

// Reglas de negocio comunes a crear y editar — no reinventar por endpoint. Ver
// docs/superpowers/specs/2026-08-19-apertura-gastos-design.md sección 7/10.1.
function validarCuerpoRegla(
  data

   ,
  ctx
) {
  if (!validarSumaPorcentajes(data.destinos)) {
    const suma = data.destinos.reduce((acc, d) => acc + d.porcentaje, 0);
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `La suma de porcentajes debe ser 100 (actual: ${suma})`,
      path: ["destinos"],
    });
  }
  const indiceDuplicado = encontrarDestinoDuplicado(
    data.destinos.map((d) => ({ localId: d.localId ?? null, puntoDeVentaId: d.puntoDeVentaId ?? null }))
  );
  if (indiceDuplicado !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Hay dos destinos con el mismo local y punto de venta",
      path: ["destinos", indiceDuplicado],
    });
  }
  validarFechasPorModo(data, ctx);
  if (data.modo === "historico" && data.confirmarHistorico !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "modo 'historico' requiere confirmarHistorico: true",
      path: ["confirmarHistorico"],
    });
  }
  validarOrigen(data, ctx);
}

const nivelReglaSchema = z.enum(["concepto", "proveedor", "registro"]).default("concepto");

const crearReglaSchema = z
  .object({
    nivel: nivelReglaSchema,
    entidadId: z.string().min(1).max(50),
    ...camposVigencia,
  })
  .superRefine((data, ctx) => {
    validarCuerpoRegla(data, ctx);
    if (data.nivel === "registro" && data.modo !== "historico") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "nivel 'registro' no admite vigencia — modo debe ser 'historico'",
        path: ["modo"],
      });
    }
  });

// PATCH tiene dos formas mutuamente excluyentes, discriminadas por "accion":
// desactivar (solo detiene aplicación futura, no toca distribuciones ya
// generadas) o editar (reemplaza destinos/vigencia y reactiva la regla
// automáticamente — ver app/api/apertura/reglas/[id]/route.ts, Task 2 de
// Fase C). No existe accion "activar" standalone: sin caso de uso sin editar
// también los datos, no se inventa (YAGNI).
const patchReglaSchema = z
  .discriminatedUnion("accion", [
    z.object({ accion: z.literal("desactivar") }),
    z.object({ accion: z.literal("editar"), ...camposVigencia }),
  ])
  .superRefine((data, ctx) => {
    if (data.accion === "editar") validarCuerpoRegla(data, ctx);
  });

// Query params de GET /api/apertura/reglas/preview-total (Fase C) — mismo
// criterio de vigencia que crear/editar, sin destinos ni confirmarHistorico
// (es una previsualización de lectura, no una escritura).
// `reglaId` (opcional) identifica la regla que se está EDITANDO: el endpoint
// se lo pasa a condicionComprasElegibles para que las compras que esa misma
// regla ya distribuyó sigan contando en el total (si no, editar una regla
// activa muestra $0 — hallazgo de la revisión final de rama, Fase C).
const previewTotalQuerySchema = z
  .object({
    nivel: nivelReglaSchema,
    entidadId: z.string().min(1).max(50),
    reglaId: z.coerce.number().int().positive().optional(),
    origenLocalId: z.coerce.number().int().positive().nullable().optional(),
    origenPuntoDeVentaId: z.coerce.number().int().nullable().optional(),
    ...camposVigenciaFecha,
  })
  .superRefine((data, ctx) => {
    validarFechasPorModo(data, ctx);
    validarOrigen(data, ctx);
  });

module.exports = { destinoSchema, camposVigenciaFecha, camposOrigen, nivelReglaSchema, crearReglaSchema, patchReglaSchema, previewTotalQuerySchema };
