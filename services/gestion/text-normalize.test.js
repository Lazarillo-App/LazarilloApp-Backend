// Portado de lazarillo_gestion/lib/text-normalize.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('./test-utils/vitest');
const { normalizarTexto, normalizarProveedorTexto } = require('./text-normalize');

describe("normalizarTexto", () => {
  it("minúsculas y sin cambios en alfanumérico simple", () => {
    expect(normalizarTexto("Diego")).toBe("diego");
  });

  it("tildes se transliteran, no se descartan (Agustín == Agustin)", () => {
    expect(normalizarTexto("Agustín")).toBe(normalizarTexto("Agustin"));
    expect(normalizarTexto("Agustín")).toBe("agustin");
  });

  it("eñe se transllitera a n", () => {
    expect(normalizarTexto("Muñoz")).toBe("munoz");
  });

  it("puntuación y espacios se descartan", () => {
    expect(normalizarTexto("Compra Ocasional / ML")).toBe(normalizarTexto("Compra Ocasional  ML"));
    expect(normalizarTexto("Compra Ocasional / ML")).toBe("compraocasionalml");
  });

  it("dos textos sin relación no coinciden", () => {
    expect(normalizarTexto("Diego")).not.toBe(normalizarTexto("Creacion Tm Sr"));
  });
});

describe("normalizarProveedorTexto", () => {
  it("con texto: normaliza el texto crudo del proveedor", () => {
    expect(normalizarProveedorTexto("Diego")).toBe("diego");
  });

  it("sin texto (null): cae al fallback 'Sin Proveedor' normalizado", () => {
    expect(normalizarProveedorTexto(null)).toBe("sinproveedor");
  });
});
