// Portado de lazarillo_gestion/lib/dashboard/params.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { buildRangoAniosUrl, parseDashboardParams, parseVentasParams, buildDashboardUrl, buildComprasDetalleUrl, monthsParam, parseObservacionQuery } = require('./params');

describe("buildRangoAniosUrl", () => {
  it("sin filtros: ruta sin query string", () => {
    expect(buildRangoAniosUrl()).toBe("/api/dashboard/rango-anios");
  });

  it("con localId: agrega localId", () => {
    expect(buildRangoAniosUrl(3)).toBe("/api/dashboard/rango-anios?localId=3");
  });

  it("con localId y pdvId: agrega ambos como puntoDeVentaId", () => {
    expect(buildRangoAniosUrl(3, 7)).toBe("/api/dashboard/rango-anios?localId=3&puntoDeVentaId=7");
  });

  it("pdvId sin localId: agrega solo puntoDeVentaId", () => {
    expect(buildRangoAniosUrl(undefined, 7)).toBe("/api/dashboard/rango-anios?puntoDeVentaId=7");
  });
});

describe("parseDashboardParams — agrupacion", () => {
  it("sin agrupacion en la URL: undefined (default concepto)", () => {
    const params = parseDashboardParams(new URLSearchParams());
    expect(params.agrupacion).toBeUndefined();
  });

  it("agrupacion=proveedor: se parsea", () => {
    const params = parseDashboardParams(new URLSearchParams("agrupacion=proveedor"));
    expect(params.agrupacion).toBe("proveedor");
  });

  it("valor inválido: undefined, no rompe", () => {
    const params = parseDashboardParams(new URLSearchParams("agrupacion=lo-que-sea"));
    expect(params.agrupacion).toBeUndefined();
  });
});

describe("parseDashboardParams — validación Zod, valores inválidos", () => {
  it("localId no numérico: undefined, no rompe (descarte silencioso)", () => {
    const params = parseDashboardParams(new URLSearchParams("localId=abc"));
    expect(params.localId).toBeUndefined();
  });

  it("localId vacío en la URL: undefined", () => {
    const params = parseDashboardParams(new URLSearchParams("localId="));
    expect(params.localId).toBeUndefined();
  });

  it("localId numérico válido: se parsea a number", () => {
    const params = parseDashboardParams(new URLSearchParams("localId=3"));
    expect(params.localId).toBe(3);
  });

  it("pdvId no numérico: undefined, no rompe", () => {
    const params = parseDashboardParams(new URLSearchParams("pdvId=xyz"));
    expect(params.pdvId).toBeUndefined();
  });

  it("proveedorId no numérico: undefined, no rompe", () => {
    const params = parseDashboardParams(new URLSearchParams("proveedorId=nope"));
    expect(params.proveedorId).toBeUndefined();
  });

  it("year fuera de rango: usa el año actual", () => {
    const params = parseDashboardParams(new URLSearchParams("year=1899"));
    expect(params.year).toBe(new Date().getFullYear());
  });

  it("year no numérico: usa el año actual", () => {
    const params = parseDashboardParams(new URLSearchParams("year=abc"));
    expect(params.year).toBe(new Date().getFullYear());
  });

  it("year ausente: usa el año actual", () => {
    const params = parseDashboardParams(new URLSearchParams());
    expect(params.year).toBe(new Date().getFullYear());
  });

  it("rubroCodigo vacío explícito en la URL: se preserva como string vacío (no undefined)", () => {
    const params = parseDashboardParams(new URLSearchParams("rubroCodigo="));
    expect(params.rubroCodigo).toBe("");
  });

  it("rubroCodigo más largo que 64: se trunca", () => {
    const params = parseDashboardParams(new URLSearchParams(`rubroCodigo=${"a".repeat(100)}`));
    expect(params.rubroCodigo).toHaveLength(64);
  });

  it("months con entradas no numéricas: se descartan, quedan solo las válidas", () => {
    const params = parseDashboardParams(new URLSearchParams("months=1,abc,3"));
    expect(params.months).toEqual([1, 3]);
  });

  it("months con las 12 entradas: undefined (equivale a sin filtro)", () => {
    const params = parseDashboardParams(new URLSearchParams("months=1,2,3,4,5,6,7,8,9,10,11,12"));
    expect(params.months).toBeUndefined();
  });
});

describe("parseVentasParams — validación Zod, valores inválidos", () => {
  it("localId no numérico: undefined, no rompe", () => {
    const params = parseVentasParams(new URLSearchParams("localId=abc"));
    expect(params.localId).toBeUndefined();
  });

  it("year fuera de rango: usa el año actual", () => {
    const params = parseVentasParams(new URLSearchParams("year=1899"));
    expect(params.year).toBe(new Date().getFullYear());
  });
});

describe("buildComprasDetalleUrl — sinProveedor", () => {
  it("con proveedorId: agrega proveedorId, no sinProveedor", () => {
    const url = buildComprasDetalleUrl({ year: 2026, proveedorId: 5 });
    expect(url).toContain("proveedorId=5");
    expect(url).not.toContain("sinProveedor");
  });

  it("con sinProveedor: agrega sinProveedor=1, no proveedorId", () => {
    const url = buildComprasDetalleUrl({ year: 2026, sinProveedor: true });
    expect(url).toContain("sinProveedor=1");
    expect(url).not.toContain("proveedorId");
  });

  it("sin proveedorId ni sinProveedor: no agrega ninguno de los dos", () => {
    const url = buildComprasDetalleUrl({ year: 2026 });
    expect(url).not.toContain("proveedorId");
    expect(url).not.toContain("sinProveedor");
  });
});

describe("buildComprasDetalleUrl — proveedorTexto", () => {
  it("con proveedorTexto: agrega proveedorTexto, no proveedorId ni sinProveedor", () => {
    const url = buildComprasDetalleUrl({ year: 2026, proveedorTexto: "Diego" });
    expect(url).toContain("proveedorTexto=Diego");
    expect(url).not.toContain("proveedorId=");
    expect(url).not.toContain("sinProveedor");
  });

  it("proveedorId tiene prioridad sobre proveedorTexto si ambos vinieran seteados", () => {
    const url = buildComprasDetalleUrl({ year: 2026, proveedorId: 5, proveedorTexto: "Diego" });
    expect(url).toContain("proveedorId=5");
    expect(url).not.toContain("proveedorTexto");
  });

  it("con proveedorTexto y codigo: agrega ambos, para separar personas con el mismo nombre", () => {
    const url = buildComprasDetalleUrl({ year: 2026, proveedorTexto: "Abril", codigo: "368" });
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("proveedorTexto")).toBe("Abril");
    expect(params.get("codigo")).toBe("368");
  });

  it("con proveedorTexto sin codigo: no agrega codigo", () => {
    const url = buildComprasDetalleUrl({ year: 2026, proveedorTexto: "Abril" });
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("proveedorTexto")).toBe("Abril");
    expect(params.has("codigo")).toBe(false);
  });

  it("codigo sin proveedorTexto: se ignora (solo acota a proveedorTexto, nunca filtra solo)", () => {
    const url = buildComprasDetalleUrl({ year: 2026, proveedorId: 5, codigo: "368" });
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.has("codigo")).toBe(false);
  });
});

describe("buildDashboardUrl — agrupacion", () => {
  it("sin agrupacion: no agrega el parámetro (default concepto)", () => {
    const url = buildDashboardUrl("/api/dashboard/pivot", { year: 2026 });
    expect(url).not.toContain("agrupacion");
  });

  it("agrupacion proveedor: se agrega a la query", () => {
    const url = buildDashboardUrl("/api/dashboard/pivot", { year: 2026, agrupacion: "proveedor" });
    expect(url).toContain("agrupacion=proveedor");
  });
});

describe("buildComprasDetalleUrl — meses y observación", () => {
  it("serializa meses como months coma-separado", () => {
    const sp = new URL(buildComprasDetalleUrl({ year: 2026, meses: [1, 2, 3] }), "http://x").searchParams;
    expect(sp.get("months")).toBe("1,2,3");
  });

  it("con mes, manda mes y no months (el mes clickeado gana)", () => {
    const sp = new URL(buildComprasDetalleUrl({ year: 2026, mes: 2, meses: [1, 2, 3] }), "http://x").searchParams;
    expect(sp.get("mes")).toBe("2");
    expect(sp.has("months")).toBe(false);
  });

  it("historico=1 reemplaza a mes/months en la URL del detalle", () => {
    const sp = new URL(buildComprasDetalleUrl({ year: 2026, mes: 7, historico: true }), "http://x").searchParams;
    expect(sp.get("historico")).toBe("1");
    expect(sp.get("mes")).toBeNull();
  });

  it("serializa importeQuery (texto tipeado tal cual)", () => {
    const sp = new URL(buildComprasDetalleUrl({ year: 2026, importeQuery: "811.980,50" }), "http://x").searchParams;
    expect(sp.get("importeQuery")).toBe("811.980,50");
  });

  it("serializa observacionQuery", () => {
    const sp = new URL(buildComprasDetalleUrl({ year: 2026, observacionQuery: "luz 50%" }), "http://x").searchParams;
    expect(sp.get("observacionQuery")).toBe("luz 50%");
  });

  it("sin meses ni observación no agrega esos params", () => {
    const url = buildComprasDetalleUrl({ year: 2026 });
    expect(url).not.toContain("months");
    expect(url).not.toContain("observacionQuery");
  });
});

describe("monthsParam", () => {
  it("parsea una lista válida", () => {
    expect(monthsParam.safeParse("1,3").data).toEqual([1, 3]);
  });

  it("los 12 meses equivalen a sin filtro", () => {
    expect(monthsParam.safeParse("1,2,3,4,5,6,7,8,9,10,11,12").data).toBeUndefined();
  });

  it("ausente o vacío: sin filtro", () => {
    expect(monthsParam.safeParse(null).data).toBeUndefined();
    expect(monthsParam.safeParse("").data).toBeUndefined();
  });

  it("un mes no entero falla el safeParse (la ruta lo trata como sin filtro)", () => {
    expect(monthsParam.safeParse("1.5").success).toBe(false);
  });
});

describe("parseObservacionQuery", () => {
  it("ausente o vacío: sin filtro", () => {
    expect(parseObservacionQuery(null)).toBeUndefined();
    expect(parseObservacionQuery("")).toBeUndefined();
  });

  it("texto corto pasa intacto", () => {
    expect(parseObservacionQuery("luz")).toBe("luz");
  });

  it("trunca a 256 en vez de descartar el filtro", () => {
    expect(parseObservacionQuery("a".repeat(300))).toBe("a".repeat(256));
  });
});
