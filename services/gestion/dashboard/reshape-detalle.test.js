// Portado de lazarillo_gestion/lib/dashboard/reshape-detalle.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { reshapeDetalle } = require('./reshape-detalle');

function filaSql(overrides = {}) {
  return {
    rowId: "r1",
    distribucionId: null,
    esDistribuido: false,
    importeBase: null,
    fecha: null,
    fechaManual: null,
    importe: null,
    importeManual: null,
    conceptoCodigoManual: null,
    concepto: null,
    detalle: null,
    observac: null,
    observacManual: null,
    proveedorTexto: null,
    proveedorId: null,
    proveedorNombre: null,
    proveedorRazon: null,
    localNombre: null,
    pdvNombre: null,
    localIdOrigen: null,
    puntoDeVentaIdOrigen: null,
    conceptoCajaCodigo: null,
    conceptoCajaNombre: null,
    conceptoCajaRubroNombre: null,
    conceptoCajaManualCodigo: null,
    conceptoCajaManualNombre: null,
    conceptoCajaManualRubroNombre: null,
    ...overrides,
  };
}

describe("reshapeDetalle", () => {
  // En una fila de fan-out `importe` es solo la fracción del destino; el modal
  // de edición necesita el total de la compra base para poder corregirlo.
  it("expone importeBase (total de la compra) separado de la fracción importe", () => {
    const fila = filaSql({ distribucionId: 7, esDistribuido: true, importe: "250.00", importeBase: "1000.00" });
    const r = reshapeDetalle(fila);
    expect(r.importe).toBe("250.00");
    expect(r.importeBase).toBe("1000.00");
  });

  it("compra sin apertura: importeBase viaja igual (la UI no lo usa, pero no se pierde)", () => {
    const r = reshapeDetalle(filaSql({ importeBase: "500.00" }));
    expect(r.importeBase).toBe("500.00");
  });
});
