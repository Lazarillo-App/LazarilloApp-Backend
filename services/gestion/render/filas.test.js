// Portado de lazarillo_gestion/lib/render/filas.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { filaDeRender, serialExcel, informeDeTabla, tipoDeOid } = require('./filas');

describe("serialExcel", () => {
  it("fecha y fecha con hora como serial de Excel", () => {
    expect(serialExcel("2026-01-01")).toBe(46023);
    expect(serialExcel("2026-01-01 00:00:00")).toBe(46023);
    expect(serialExcel("2026-01-01T12:00:00Z")).toBe(46023.5);
    expect(serialExcel("cualquier cosa")).toBeNull();
  });
});

describe("filaDeRender", () => {
  const tipos = { pdv: "texto", cod_cga: "numero", fecha: "fecha", concepto: "texto", observac: "texto", importe: "numero", caja_pago: "texto" };
  it("deja la fila igual a la del Excel: mayúsculas, sin pdv, serial, números y texto al ancho de MaxiRest", () => {
    expect(filaDeRender({ pdv: "BAR", cod_cga: "1", fecha: "2026-01-01 00:00:00", concepto: "Almacen", observac: null, importe: "106904.22", caja_pago: null }, tipos)).toEqual({
      COD_CGA: 1,
      FECHA: 46023,
      CONCEPTO: "Almacen".padEnd(25),
      OBSERVAC: " ".repeat(40),
      IMPORTE: 106904.22,
    });
  });
  it("número o fecha nulos no aparecen (como una celda vacía del Excel)", () => {
    expect(filaDeRender({ cod_cga: null, fecha: null }, tipos)).toEqual({});
  });
});

describe("informeDeTabla", () => {
  it("reconoce las tablas del Panel con y sin año", () => {
    expect(informeDeTabla("i14_gastos_compras_detallado_2026")).toMatchObject({ anio: 2026, informe: { fileType: "compras" } });
    expect(informeDeTabla("i000_nomina")).toMatchObject({ anio: null, informe: { fileType: "nomina" } });
    expect(informeDeTabla("i22_ventas_detalladas_2025")).toMatchObject({ informe: { fileType: "ventas", requiereOrden: true } });
    expect(informeDeTabla("i12_ventas_por_articulo_ranking_detallado_por_dia_2026")).toBeNull();
    expect(informeDeTabla("m17_conceptos_de_caja")).toMatchObject({ anio: null, informe: { fileType: "conceptosCaja", maestro: true } });
    expect(informeDeTabla("m6_listado_de_articulos")).toBeNull();
  });
});

describe("tipoDeOid", () => {
  it("timestamp, numeric, bigint y texto", () => {
    expect(tipoDeOid(1114)).toBe("fecha");
    expect(tipoDeOid(1700)).toBe("numero");
    expect(tipoDeOid(20)).toBe("numero");
    expect(tipoDeOid(25)).toBe("texto");
  });
});
