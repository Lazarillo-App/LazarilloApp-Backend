// Portado de lazarillo_gestion/lib/arca/corregir.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect, vi } = require('../test-utils/vitest');
const { diagnosticoImporte, sugerirAnular } = require('./corregir');

const f = (x) => ({ rowId: "r", comprobante: "A1", localId: 1, fecha: "2025-09-09", concepto: null, cod: "3", importe: 0, origen: null, renNeto: 0, renIva: 0, renN: 0, pagos: 0, anulada: false, renglones: null, ...x });

describe("corregir con ARCA", () => {
  it("Horeca: renglones bien, a Caja le falta el Dambo; falta una percepción", () => {
    const d = diagnosticoImporte({ neto: 836525.57, iva: 175670.37, noGravado: 0, exento: 0, otros: 92017.82, total: 1104213.76 }, [
      f({ rowId: "lac", concepto: "Lacteos", importe: 584226.2, renNeto: 836525.56, renIva: 175670.38, renN: 8,
        renglones: [{ nombre: "Cheddar Pasta Milkaut", total: 110105.16 }, { nombre: "Dambo Feteado", total: 427969.74 }, { nombre: "Lomo Ahumado", total: 162652.69 }] }),
      f({ rowId: "p1", cod: "133", importe: 25095.77 }),
      f({ rowId: "p2", cod: "899", importe: 41826.28 }),
    ]);
    expect(d.partes[0].ok).toBe(false);
    expect(d.textos[0]).toContain("falta Dambo Feteado");
    expect(d.igualar).toMatchObject({ rowId: "lac", importe: 1012195.94 });
    expect(d.percepcion).toMatchObject({ importe: 25095.77, sugerida: "" });
  });
  it("Atlantis: neto + IVA bien, percepción en cero", () => {
    const d = diagnosticoImporte({ neto: 8093000, iva: 1699524, noGravado: 0, exento: 0, otros: 890226, total: 10682750 }, [f({ rowId: "x", importe: 9792521 })]);
    expect(d.igualar).toBeNull();
    expect(d.percepcion).toMatchObject({ importe: 890226, base: { rowId: "x" } });
  });
  it("duplicado KeegoChat: sugiere anular la que no tiene renglones ni pago", () => {
    const g = [
      { comprobante: "A000200000224", filas: [f({ rowId: "a", comprobante: "A000200000224", fecha: "2025-08-01", renN: 1, pagos: 1, importe: 505359 })] },
      { comprobante: "FCA000200000224", filas: [f({ rowId: "b", comprobante: "FCA000200000224", fecha: "2025-08-01", importe: 505359 })] },
    ];
    expect(sugerirAnular(g, "2025-08-01")).toBe("FCA000200000224");
  });
  it("si no hay cómo distinguirlas, no sugiere", () => {
    const g = [{ comprobante: "A", filas: [f({})] }, { comprobante: "B", filas: [f({})] }];
    expect(sugerirAnular(g, "2025-09-09")).toBeNull();
  });
  it("Get Clean: versión vieja de una fila editada en MaxiRest → no ofrece corregir", () => {
    const fila = (rowId, importe, cod = "20") => ({ rowId, comprobante: "A000600004136", localId: 1, fecha: "2026-10-14", concepto: "x", cod, importe, origen: null, renNeto: 0, renIva: 0, renN: 0, pagos: 0, anulada: false, renglones: null });
    const d = diagnosticoImporte({ neto: 407734.49, iva: 85624.24, noGravado: 0, exento: 0, otros: 0, total: 493358.73 },
      [fila("vieja", 493358.73), fila("nueva", 484447.72), fila("iva", 8911, "820")]);
    expect(d.igualar).toBeNull();
    expect(d.textos[0]).toContain("versión vieja");
  });
});
