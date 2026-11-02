// Portado de lazarillo_gestion/lib/etl/fila-cruda.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { filaCruda } = require('./helpers');

describe("filaCruda (punto 7 — omitidos con la fila completa)", () => {
  it("usa el número de fila real del Excel si la hoja lo trajo (encabezado = 1)", () => {
    const r = { COD_CGA: "885", FECHA: 46000 };
    Object.defineProperty(r, "__rowNum__", { value: 119, enumerable: false });
    const f = filaCruda(r, 5);
    expect(f.fila).toBe(120);
    expect(Object.keys(f.columnas)).toEqual(["COD_CGA", "FECHA"]); // __rowNum__ no es columna
  });

  it("sin número de fila cae al índice + 2 (primera fila de datos = 2)", () => {
    expect(filaCruda({ A: 1 }, 0).fila).toBe(2);
  });

  it("todas las columnas como texto; fechas en serial Excel → dd/mm/aaaa; vacíos → ''", () => {
    const f = filaCruda({ FECHA: 45000, IMPORTE: 1500.5, OBSERVAC: null, DETALLE: "A 0001-00000002", FEC_VTO: 45001 }, 0);
    expect(f.columnas.FECHA).toMatch(/^\d{2}\/\d{2}\/2023$/);
    expect(f.columnas.FEC_VTO).toMatch(/^\d{2}\/\d{2}\/2023$/);
    expect(f.columnas.IMPORTE).toBe("1500.5");
    expect(f.columnas.OBSERVAC).toBe("");
    expect(f.columnas.DETALLE).toBe("A 0001-00000002");
  });
});
