// Portado de lazarillo_gestion/lib/render/filas-ventas.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { filaDeRender, comprobanteDelExcel, horaDelExcel } = require('./filas');
const { makeRowId } = require('../etl/normalizers/ventas');

// Fila real del 22 del Bar 2026, como la trae el Excel y como la guarda Render.
const excel = {
  TURNO: "Mañ", COMPROBANT: "  FCB 0006-00004888 ", HORA: 0.5479166666666667, COBRO: "Transferencia MP ",
  COD_COBRO: "W", IMPORTE: 19710, CUPON: 1403977466, FECHA: 46024,
};
const render = {
  pdv: "BAR", fila: 3, turno: "Mañ", comprobant: "FCB 0006-00004888", hora: "13:09:00", cobro: "Transferencia MP",
  cod_cobro: "W", importe: "19710.0", cupon: "1403977466", fecha: "2026-01-02 00:00:00",
};
const tipos = { pdv: "texto", fila: "numero", turno: "texto", comprobant: "texto", hora: "texto", cobro: "texto",
  cod_cobro: "texto", importe: "numero", cupon: "numero", fecha: "fecha" };

describe("22 desde Render", () => {
  it("rearma el comprobante con los 2 espacios de adelante", () => {
    expect(comprobanteDelExcel("FCB 0006-00004888")).toBe("  FCB 0006-00004888 ");
    expect(comprobanteDelExcel("TIC 0001-00003128")).toBe("  TIC 0001-00003128 ");
    expect(comprobanteDelExcel("TOTALES DEL DIA:")).toBeNull();
    // Letra de una posición: Render la guarda "U   0006-…" (3 espacios) y el Excel "  U   0006-… ".
    expect(comprobanteDelExcel("U   0006-00032398")).toBe("  U   0006-00032398 ");
    expect(comprobanteDelExcel("_   0001-00000111")).toBe("  _   0001-00000111 ");
  });
  it("hora como fracción del día, igual que el Excel", () => {
    expect(horaDelExcel("13:09:00")).toBe(0.5479166666666667);
    expect(horaDelExcel("00:15:00")).toBe(0.01041666666666667);
    expect(horaDelExcel("")).toBeNull();
  });
  it("misma venta = mismo rowId (no se duplica)", () => {
    const r = filaDeRender(render, tipos);
    expect(r.COMPROBANT).toBe(excel.COMPROBANT);
    expect(r.HORA).toBe(excel.HORA);
    expect(r.FILA).toBeUndefined();
    expect(makeRowId(r)).toBe(makeRowId(excel));
  });
});
