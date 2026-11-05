// Portado de lazarillo_gestion/lib/dashboard/fuente-compras.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { fuenteCompras } = require('./fuente-compras');
const { compraRowSchema } = require('../etl/schemas/compras');

describe("switch Económica / Financiera", () => {
  it("Económica: sueldos por PERIODO, la fecha editada en Lazarillo sigue mandando", () => {
    const sql = fuenteCompras("economica").sql;
    expect(sql).toContain('COALESCE(v.periodo, v.fecha) AS fecha');
    expect(sql).not.toContain("JOIN compras");
    expect(sql).toContain('v."fechaManual"');
    expect(sql).not.toContain("pagos");
  });
  it("Financiera: gastos varios por fecha de pago, facturas una fila por pago del 80", () => {
    const q = fuenteCompras("financiera", "2025-09-01");
    expect(q.sql).toContain('COALESCE(b.fpago, b."fechaManual", b.fecha) AS fecha');
    expect(q.sql).toContain('COALESCE(pg."fechaPagoManual", pg."fechaPago")::timestamp(3) AS fecha');
    expect(q.sql).toContain("JOIN gestion_pagos pg");
    expect(q.sql).toContain("NOT MATERIALIZED");
    expect(q.values).toContain("2025-09-01");
  });
});

describe("14 con las columnas nuevas del kit", () => {
  const base = { COD_CGA: "885", FECHA: 46024, IMPORTE: 1000 };
  it("lee FECHA_PAGO, CAJA_PAGO y PERIODO", () => {
    const r = compraRowSchema.parse({ ...base, FECHA_PAGO: 46027, CAJA_PAGO: "CAJA MAYOR", PERIODO: 45992 });
    expect(r.FECHA_PAGO?.toISOString().slice(0, 10)).toBe("2026-01-05");
    expect(r.CAJA_PAGO).toBe("CAJA MAYOR");
    expect(r.PERIODO?.toISOString().slice(0, 10)).toBe("2025-12-01");
  });
  it("un 14 viejo sin las columnas, o con una fecha rota, no tira la fila", () => {
    expect(compraRowSchema.parse(base).FECHA_PAGO).toBeNull();
    expect(compraRowSchema.parse({ ...base, FECHA_PAGO: "basura" }).FECHA_PAGO).toBeNull();
  });
});

describe("Vista Insumos: parámetros", async () => {
  const { parseDashboardParams, buildComprasDetalleUrl } = require("./params");
  it("acepta agrupacion=insumo y descarta valores raros", () => {
    expect(parseDashboardParams(new URLSearchParams("year=2026&agrupacion=insumo")).agrupacion).toBe("insumo");
    expect(parseDashboardParams(new URLSearchParams("year=2026&agrupacion=x")).agrupacion).toBeUndefined();
  });
  it("el detalle filtra por insumo o por compras sin insumos", () => {
    expect(buildComprasDetalleUrl({ year: 2026, insumoCodigo: "17" })).toContain("insumoCodigo=17");
    expect(buildComprasDetalleUrl({ year: 2026, conceptoCodigo: "201", sinInsumos: true })).toContain("sinInsumos=1");
  });
});
