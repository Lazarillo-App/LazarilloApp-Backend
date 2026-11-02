// Portado de lazarillo_gestion/lib/etl/helpers.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const XLSX = require('xlsx');
const { trim, toDecimal, toDecimalStr, toBool, excelDateToISO, safeDate, normalizeText, normalizePhone, normalizeCuit, readExcelBuffer, getExcelHeaders } = require('./helpers');

function makeXlsxBuffer(rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

describe("trim", () => {
  it("null/undefined -> null", () => {
    expect(trim(null)).toBeNull();
    expect(trim(undefined)).toBeNull();
  });

  it("string vacía o solo espacios -> null", () => {
    expect(trim("")).toBeNull();
    expect(trim("   ")).toBeNull();
  });

  it("recorta espacios", () => {
    expect(trim("  abc  ")).toBe("abc");
  });

  it("valor no-string se convierte a string", () => {
    expect(trim(42)).toBe("42");
  });
});

describe("toDecimal", () => {
  it("null/undefined/vacío -> null", () => {
    expect(toDecimal(null)).toBeNull();
    expect(toDecimal(undefined)).toBeNull();
    expect(toDecimal("")).toBeNull();
    expect(toDecimal(" ")).toBeNull();
  });

  it("no numérico -> null", () => {
    expect(toDecimal("abc")).toBeNull();
  });

  it("string numérica -> number", () => {
    expect(toDecimal("1234.5")).toBe(1234.5);
  });

  it("number pasa igual", () => {
    expect(toDecimal(1234)).toBe(1234);
  });

  it("'0' es un valor válido, no se trata como ausente", () => {
    expect(toDecimal("0")).toBe(0);
  });
});

describe("toDecimalStr", () => {
  it("null/undefined/vacío -> null", () => {
    expect(toDecimalStr(null)).toBeNull();
    expect(toDecimalStr(undefined)).toBeNull();
    expect(toDecimalStr("")).toBeNull();
    expect(toDecimalStr(" ")).toBeNull();
  });

  it("no numérico -> null", () => {
    expect(toDecimalStr("abc")).toBeNull();
  });

  it("devuelve string, no number", () => {
    const result = toDecimalStr("1234.5");
    expect(typeof result).toBe("string");
    expect(result).toBe("1234.5");
  });

  it("preserva precisión completa (a diferencia de toDecimal, sin drift de punto flotante)", () => {
    expect(toDecimalStr("1234.123456789")).toBe("1234.123456789");
  });
});

describe("toBool", () => {
  it("null/undefined -> null", () => {
    expect(toBool(null)).toBeNull();
    expect(toBool(undefined)).toBeNull();
  });

  it("boolean pasa igual", () => {
    expect(toBool(true)).toBe(true);
    expect(toBool(false)).toBe(false);
  });

  it("1/'1'/'true' -> true; 0/'0'/'false' -> false", () => {
    expect(toBool(1)).toBe(true);
    expect(toBool("1")).toBe(true);
    expect(toBool("true")).toBe(true);
    expect(toBool(0)).toBe(false);
    expect(toBool("0")).toBe(false);
    expect(toBool("false")).toBe(false);
  });

  it("valores no reconocidos -> null (match exacto, case-sensitive: 'TRUE'/'yes'/2 no cuentan)", () => {
    expect(toBool("TRUE")).toBeNull();
    expect(toBool("yes")).toBeNull();
    expect(toBool(2)).toBeNull();
  });
});

describe("excelDateToISO", () => {
  it("null/undefined/false/vacío -> null", () => {
    expect(excelDateToISO(null)).toBeNull();
    expect(excelDateToISO(undefined)).toBeNull();
    expect(excelDateToISO(false)).toBeNull();
    expect(excelDateToISO("")).toBeNull();
  });

  it("serial Excel válido -> fecha ISO", () => {
    expect(excelDateToISO(45000)).toBe("2023-03-15");
  });

  it("string de fecha (no serial numérico) -> null: límite conocido, no maneja typeof string", () => {
    expect(excelDateToISO("2023-03-15")).toBeNull();
  });
});

describe("safeDate", () => {
  it("delega en excelDateToISO: null si no hay serial numérico válido", () => {
    expect(safeDate(null)).toBeNull();
    expect(safeDate("2023-03-15")).toBeNull();
  });

  it("serial válido -> Date válido", () => {
    const d = safeDate(45000);
    expect(d).toBeInstanceOf(Date);
    expect(Number.isNaN(d?.getTime())).toBe(false);
  });
});

describe("normalizeText", () => {
  it("null/undefined -> null", () => {
    expect(normalizeText(null)).toBeNull();
    expect(normalizeText(undefined)).toBeNull();
  });

  it("vacío o solo espacios -> null", () => {
    expect(normalizeText("")).toBeNull();
    expect(normalizeText("   ")).toBeNull();
  });

  it("recorta espacios y title-case cada palabra", () => {
    expect(normalizeText("  hola mundo  ")).toBe("Hola Mundo");
  });

  it("elimina caracteres de control", () => {
    expect(normalizeText("abc\x00\x1Fdef")).toBe("Abcdef");
  });

  it("colapsa espacios múltiples a uno", () => {
    expect(normalizeText("a   b")).toBe("A B");
  });

  it("colapsa guiones múltiples a uno", () => {
    expect(normalizeText("a--b")).toBe("A-b");
  });
});

describe("normalizePhone", () => {
  it("null/undefined/vacío -> null", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  it("solo dígitos: queda igual", () => {
    expect(normalizePhone("1122334455")).toBe("1122334455");
  });

  it("con espacios y guiones: quita espacios, conserva guiones", () => {
    expect(normalizePhone("11 2233-4455")).toBe("112233-4455");
  });

  it("valor con letras no se rechaza, pasa sin normalizar (no se dropea el dato)", () => {
    expect(normalizePhone("llamar")).toBe("llamar");
  });
});

describe("normalizeCuit", () => {
  it("null/undefined/vacío -> null", () => {
    expect(normalizeCuit(null)).toBeNull();
    expect(normalizeCuit(undefined)).toBeNull();
    expect(normalizeCuit("")).toBeNull();
  });

  it("con guiones -> sin guiones", () => {
    expect(normalizeCuit("20-12345678-9")).toBe("20123456789");
  });

  it("con espacios -> sin espacios", () => {
    expect(normalizeCuit("20 12345678 9")).toBe("20123456789");
  });

  it("sin puntuación pasa igual", () => {
    expect(normalizeCuit("20123456789")).toBe("20123456789");
  });
});

describe("readExcelBuffer / getExcelHeaders", () => {
  it("readExcelBuffer normaliza las keys a UPPERCASE", () => {
    const buffer = makeXlsxBuffer([
      ["codigo", "Nombre"],
      ["A1", "Juan"],
    ]);
    const rows = readExcelBuffer(buffer);
    expect(rows).toEqual([{ CODIGO: "A1", NOMBRE: "Juan" }]);
  });

  it("getExcelHeaders devuelve solo la fila de encabezados", () => {
    const buffer = makeXlsxBuffer([
      ["CODIGO", "NOMBRE"],
      ["A1", "Juan"],
      ["A2", "Ana"],
    ]);
    expect(getExcelHeaders(buffer)).toEqual(["CODIGO", "NOMBRE"]);
  });
});
