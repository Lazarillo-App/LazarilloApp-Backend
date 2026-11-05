// Portado de lazarillo_gestion/lib/apertura/schemas.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { crearReglaSchema, patchReglaSchema, previewTotalQuerySchema } = require('./schemas');

const destinosOk = [
  { localId: 1, porcentaje: 60 },
  { localId: 2, porcentaje: 40 },
];

const baseWithOrigen = { origenLocalId: 1, origenPuntoDeVentaId: 10 };

describe("crearReglaSchema", () => {
  it("acepta un cuerpo válido en modo entre_fechas", () => {
    const result = crearReglaSchema.safeParse({
      entidadId: "17",
      modo: "entre_fechas",
      fechaDesde: "2026-01-01T00:00:00Z",
      fechaHasta: "2026-01-31T00:00:00Z",
      extremosInclusivos: true,
      destinos: destinosOk,
      ...baseWithOrigen,
    });
    expect(result.success).toBe(true);
  });

  it("rechaza suma de porcentajes != 100 (CA-10)", () => {
    const result = crearReglaSchema.safeParse({
      entidadId: "17",
      modo: "historico",
      confirmarHistorico: true,
      destinos: [{ localId: 1, porcentaje: 60 }, { localId: 2, porcentaje: 30 }],
      ...baseWithOrigen,
    });
    expect(result.success).toBe(false);
  });

  it("rechaza modo historico sin confirmarHistorico (CA-06: advertencia obligatoria en histórico completo)", () => {
    const result = crearReglaSchema.safeParse({
      entidadId: "17",
      modo: "historico",
      destinos: destinosOk,
      ...baseWithOrigen,
    });
    expect(result.success).toBe(false);
  });

  it("acepta modo historico con confirmarHistorico: true", () => {
    const result = crearReglaSchema.safeParse({
      entidadId: "17",
      modo: "historico",
      confirmarHistorico: true,
      destinos: destinosOk,
      ...baseWithOrigen,
    });
    expect(result.success).toBe(true);
  });

  it("rechaza entre_fechas sin fechaHasta", () => {
    const result = crearReglaSchema.safeParse({
      entidadId: "17",
      modo: "entre_fechas",
      fechaDesde: "2026-01-01T00:00:00Z",
      destinos: destinosOk,
      ...baseWithOrigen,
    });
    expect(result.success).toBe(false);
  });

  it("rechaza desde_adelante sin fechaDesde", () => {
    const result = crearReglaSchema.safeParse({
      entidadId: "17",
      modo: "desde_adelante",
      destinos: destinosOk,
      ...baseWithOrigen,
    });
    expect(result.success).toBe(false);
  });

  it("rechaza un destino sin localId ni puntoDeVentaId", () => {
    const result = crearReglaSchema.safeParse({
      entidadId: "17",
      modo: "historico",
      confirmarHistorico: true,
      destinos: [{ porcentaje: 100 }],
      ...baseWithOrigen,
    });
    expect(result.success).toBe(false);
  });

  it("rechaza lista de destinos vacía", () => {
    const result = crearReglaSchema.safeParse({
      entidadId: "17",
      modo: "historico",
      confirmarHistorico: true,
      destinos: [],
      ...baseWithOrigen,
    });
    expect(result.success).toBe(false);
  });

  it("rechaza entidadId vacío", () => {
    const result = crearReglaSchema.safeParse({
      entidadId: "",
      modo: "historico",
      confirmarHistorico: true,
      destinos: destinosOk,
      ...baseWithOrigen,
    });
    expect(result.success).toBe(false);
  });

  it("rechaza dos destinos con el mismo local y punto de venta", () => {
    const result = crearReglaSchema.safeParse({
      entidadId: "17",
      modo: "historico",
      confirmarHistorico: true,
      destinos: [
        { localId: 1, puntoDeVentaId: 5, porcentaje: 50 },
        { localId: 1, puntoDeVentaId: 5, porcentaje: 50 },
      ],
      ...baseWithOrigen,
    });
    expect(result.success).toBe(false);
  });

  it("rechaza 'todo el local' superpuesto con un punto de venta específico del mismo local", () => {
    const result = crearReglaSchema.safeParse({
      entidadId: "17",
      modo: "historico",
      confirmarHistorico: true,
      destinos: [
        { localId: 1, puntoDeVentaId: 5, porcentaje: 50 },
        { localId: 1, porcentaje: 50 },
      ],
      ...baseWithOrigen,
    });
    expect(result.success).toBe(false);
  });
});

describe("patchReglaSchema", () => {
  it("acepta accion: desactivar sin más campos", () => {
    const result = patchReglaSchema.safeParse({ accion: "desactivar" });
    expect(result.success).toBe(true);
  });

  it("acepta accion: editar con cuerpo completo válido", () => {
    const result = patchReglaSchema.safeParse({
      accion: "editar",
      modo: "desde_adelante",
      fechaDesde: "2026-03-01T00:00:00Z",
      destinos: destinosOk,
      ...baseWithOrigen,
    });
    expect(result.success).toBe(true);
  });

  it("rechaza accion: editar con suma de porcentajes inválida", () => {
    const result = patchReglaSchema.safeParse({
      accion: "editar",
      modo: "desde_adelante",
      fechaDesde: "2026-03-01T00:00:00Z",
      destinos: [{ localId: 1, porcentaje: 50 }],
      ...baseWithOrigen,
    });
    expect(result.success).toBe(false);
  });

  it("rechaza una acción desconocida", () => {
    const result = patchReglaSchema.safeParse({ accion: "reactivar" });
    expect(result.success).toBe(false);
  });

  it("rechaza cuerpo sin accion", () => {
    const result = patchReglaSchema.safeParse({ modo: "historico" });
    expect(result.success).toBe(false);
  });
});

describe("previewTotalQuerySchema", () => {
  it("acepta modo historico con solo entidadId (sin confirmarHistorico — no aplica al preview)", () => {
    const result = previewTotalQuerySchema.safeParse({ entidadId: "17", modo: "historico", ...baseWithOrigen });
    expect(result.success).toBe(true);
  });

  it("acepta modo entre_fechas con ambas fechas", () => {
    const result = previewTotalQuerySchema.safeParse({
      entidadId: "17",
      modo: "entre_fechas",
      fechaDesde: "2026-01-01T00:00:00Z",
      fechaHasta: "2026-01-31T00:00:00Z",
      ...baseWithOrigen,
    });
    expect(result.success).toBe(true);
  });

  it("rechaza desde_adelante sin fechaDesde", () => {
    const result = previewTotalQuerySchema.safeParse({ entidadId: "17", modo: "desde_adelante", ...baseWithOrigen });
    expect(result.success).toBe(false);
  });

  it("rechaza desde_atras sin fechaHasta", () => {
    const result = previewTotalQuerySchema.safeParse({ entidadId: "17", modo: "desde_atras", ...baseWithOrigen });
    expect(result.success).toBe(false);
  });

  it("rechaza entidadId vacío", () => {
    const result = previewTotalQuerySchema.safeParse({ entidadId: "", modo: "historico", ...baseWithOrigen });
    expect(result.success).toBe(false);
  });

  it("nivel default es 'concepto' si se omite", () => {
    const r = previewTotalQuerySchema.safeParse({
      entidadId: "48", origenLocalId: 1, origenPuntoDeVentaId: 10, modo: "historico",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.nivel).toBe("concepto");
  });
});

describe("origen de la regla", () => {
  const base = {
    entidadId: "17", modo: "historico", confirmarHistorico: true,
    destinos: [{ localId: 1, porcentaje: 60 }, { localId: 2, porcentaje: 40 }],
  };
  it("rechaza origen con solo origenLocalId (regla debe apuntar a un PDV puntual)", () => {
    expect(crearReglaSchema.safeParse({ ...base, origenLocalId: 1 }).success).toBe(false);
  });
  it("acepta origen con origenLocalId y origenPuntoDeVentaId", () => {
    expect(crearReglaSchema.safeParse({ ...base, origenLocalId: 1, origenPuntoDeVentaId: 10 }).success).toBe(true);
  });
  it("acepta origen con solo origenPuntoDeVentaId (el local se resuelve server-side)", () => {
    expect(crearReglaSchema.safeParse({ ...base, origenPuntoDeVentaId: 10 }).success).toBe(true);
  });
  it("rechaza cuerpo sin ningún campo de origen", () => {
    expect(crearReglaSchema.safeParse(base).success).toBe(false);
  });
  it("rechaza origen con ambos campos en null", () => {
    expect(crearReglaSchema.safeParse({ ...base, origenLocalId: null, origenPuntoDeVentaId: null }).success).toBe(false);
  });
  it("previewTotalQuerySchema coerce origenPuntoDeVentaId de string", () => {
    const r = previewTotalQuerySchema.safeParse({ entidadId: "17", modo: "historico", origenLocalId: "3", origenPuntoDeVentaId: "10" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.origenPuntoDeVentaId).toBe(10);
  });
  it("previewTotalQuerySchema rechaza sin origen", () => {
    expect(previewTotalQuerySchema.safeParse({ entidadId: "17", modo: "historico" }).success).toBe(false);
  });
  it("previewTotalQuerySchema rechaza origen con solo local", () => {
    expect(previewTotalQuerySchema.safeParse({ entidadId: "17", modo: "historico", origenLocalId: 1 }).success).toBe(false);
  });
});

describe("crearReglaSchema — nivel", () => {
  const base = {
    entidadId: "48",
    origenLocalId: 1,
    origenPuntoDeVentaId: 10,
    destinos: [{ localId: 1, porcentaje: 100 }],
  };

  it("default de nivel es 'concepto' si se omite (compatibilidad hacia atrás)", () => {
    const r = crearReglaSchema.safeParse({ ...base, modo: "historico", confirmarHistorico: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.nivel).toBe("concepto");
  });

  it("nivel 'registro' con modo 'historico' es válido", () => {
    const r = crearReglaSchema.safeParse({
      ...base, nivel: "registro", modo: "historico", confirmarHistorico: true,
    });
    expect(r.success).toBe(true);
  });

  it("nivel 'registro' con modo distinto de 'historico' es inválido", () => {
    const r = crearReglaSchema.safeParse({
      ...base, nivel: "registro", modo: "desde_adelante", fechaDesde: "2026-01-01T00:00:00Z",
    });
    expect(r.success).toBe(false);
  });

  it("nivel 'proveedor' admite cualquier modo de vigencia, igual que concepto", () => {
    const r = crearReglaSchema.safeParse({
      ...base, nivel: "proveedor", entidadId: "123", modo: "desde_adelante", fechaDesde: "2026-01-01T00:00:00Z",
    });
    expect(r.success).toBe(true);
  });

  it("rechaza un nivel que no sea concepto/proveedor/registro", () => {
    const r = crearReglaSchema.safeParse({
      nivel: "no-existe", entidadId: "48", origenLocalId: 1, origenPuntoDeVentaId: 10,
      modo: "historico", confirmarHistorico: true,
      destinos: [{ localId: 1, porcentaje: 100 }],
    });
    expect(r.success).toBe(false);
  });
});
