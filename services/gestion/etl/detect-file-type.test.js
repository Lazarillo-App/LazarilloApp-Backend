// Portado de lazarillo_gestion/lib/etl/detect-file-type.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { detectFileType, buildTipoNoIdentificadoMessage } = require('./detect-file-type');

describe("detectFileType", () => {
  it("rubrosArticulo: headers mínimos requeridos", () => {
    expect(detectFileType(["GRUPO_NRO", "GRUPO_COL", "GRUPO_FOT", "EXCLUYEINF"])).toBe("rubrosArticulo");
  });

  it("subrubrosArticulo: headers mínimos requeridos", () => {
    expect(detectFileType(["EVE_FOR", "EVE_FORM", "EVE_FORMH"])).toBe("subrubrosArticulo");
  });

  it("rubrosConceptoCaja: headers mínimos requeridos", () => {
    expect(detectFileType(["CODIGO", "NOMBRE", "CALC_RENT"])).toBe("rubrosConceptoCaja");
  });

  it("conceptosCaja: headers mínimos requeridos", () => {
    expect(detectFileType(["TIPO", "COD_IMP", "COD_RGA"])).toBe("conceptosCaja");
  });

  it("articulos: headers mínimos requeridos", () => {
    expect(detectFileType(["PRECIO1", "PRECIO2", "PRECIO3", "PRECIO4"])).toBe("articulos");
  });

  it("proveedores: headers mínimos requeridos", () => {
    expect(detectFileType(["RAZON", "CUIT", "CBU", "ALIASCBU"])).toBe("proveedores");
  });

  it("detalleCompras: headers mínimos requeridos", () => {
    expect(detectFileType(["COD_CPB", "NUMERO1", "NUMERO2", "TOTALINS"])).toBe("detalleCompras");
  });

  it("compras: headers mínimos requeridos", () => {
    expect(detectFileType(["COD_CGA", "IMPUTAC", "PER1"])).toBe("compras");
  });

  it("ventas: headers mínimos requeridos", () => {
    expect(detectFileType(["TURNO", "COMPROBANT", "COBRO", "COD_COBRO"])).toBe("ventas");
  });

  it("headers extra no rompen el match", () => {
    expect(detectFileType(["COD_CGA", "IMPUTAC", "PER1", "OBSERVAC", "DETALLE"])).toBe("compras");
  });

  it("mayúsculas/minúsculas y espacios no importan", () => {
    expect(detectFileType(["  cod_cga ", "Imputac", "PER1 "])).toBe("compras");
  });

  it("headers desconocidos -> null", () => {
    expect(detectFileType(["FOO", "BAR"])).toBeNull();
  });

  it("array vacío -> null", () => {
    expect(detectFileType([])).toBeNull();
  });

  it("match parcial (falta un header requerido) -> null", () => {
    expect(detectFileType(["COD_CGA", "IMPUTAC"])).toBeNull();
  });

  it("el orden de DETECTION_RULES importa: la regla declarada primero gana en un header set ambiguo", () => {
    // Unión de los headers requeridos de rubrosConceptoCaja (declarada antes) y conceptosCaja
    // (declarada después) — ningún header se superpone entre reglas, así que para generar
    // ambigüedad real hay que unir explícitamente ambos sets requeridos.
    const ambiguousHeaders = ["CODIGO", "NOMBRE", "CALC_RENT", "TIPO", "COD_IMP", "COD_RGA"];
    expect(detectFileType(ambiguousHeaders)).toBe("rubrosConceptoCaja");
  });
});

describe("buildTipoNoIdentificadoMessage", () => {
  it("incluye las columnas encontradas separadas por coma", () => {
    expect(buildTipoNoIdentificadoMessage(["COD_RUI", "CODIGO", "NOMBRE"])).toBe(
      "No se pudo identificar el tipo de archivo. Columnas encontradas: COD_RUI, CODIGO, NOMBRE"
    );
  });

  it("headers vacíos -> mensaje sin columnas listadas", () => {
    expect(buildTipoNoIdentificadoMessage([])).toBe(
      "No se pudo identificar el tipo de archivo. Columnas encontradas: "
    );
  });
});
