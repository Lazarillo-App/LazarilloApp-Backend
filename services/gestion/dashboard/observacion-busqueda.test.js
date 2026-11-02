// Portado de lazarillo_gestion/lib/dashboard/observacion-busqueda.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { quitarAcentos, ACENTOS_DESDE, ACENTOS_HACIA, opcionContiene } = require('./observacion-busqueda');

describe("quitarAcentos", () => {
  it("saca tildes de vocales minúsculas", () => {
    expect(quitarAcentos("eléctrico árbol índice canción único")).toBe("electrico arbol indice cancion unico");
  });

  it("saca tildes de vocales mayúsculas y la diéresis", () => {
    expect(quitarAcentos("ÁÉÍÓÚ pingüino PINGÜINO")).toBe("AEIOU pinguino PINGUINO");
  });

  it("no toca la ñ: 'año' y 'ano' son palabras distintas", () => {
    expect(quitarAcentos("año AÑO")).toBe("año AÑO");
  });

  it("deja intactos los comodines y el escape de LIKE", () => {
    expect(quitarAcentos("50% a_b c\\d")).toBe("50% a_b c\\d");
  });

  it("la tabla de reemplazo es 1 a 1 (requisito de translate en Postgres)", () => {
    expect([...ACENTOS_DESDE].length).toBe([...ACENTOS_HACIA].length);
  });
});

describe("opcionContiene", () => {
  it("con menos de 2 caracteres no ofrece la opción", () => {
    expect(opcionContiene("")).toBeNull();
    expect(opcionContiene("  c  ")).toBeNull();
  });

  it("filtra por lo tipeado, sin espacios en los bordes", () => {
    expect(opcionContiene("  canaletas ")).toEqual({
      query: "canaletas",
      label: "contiene «canaletas»",
    });
  });
});
