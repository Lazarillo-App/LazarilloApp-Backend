'use strict';
const { describe, it, expect } = require('../test-utils/vitest');
const { buildDetalleConditions } = require('./detalle-api');

const texto = (conds) => conds.map((c) => c.sql).join(' AND ');

describe("buildDetalleConditions", () => {
  it("siempre acota al negocio activo", () => {
    const s = texto(buildDetalleConditions({ businessId: 7, year: 2026, sinProveedor: false }));
    expect(s).toContain("c.business_id =");
  });
  it("sin rubro ni concepto excluye los rubros ocultos del negocio", () => {
    const s = texto(buildDetalleConditions({ businessId: 7, year: 2026, sinProveedor: false }));
    expect(s).toContain('rv."visibleEnDashboard"');
  });
  it("por concepto usa el concepto efectivo (manual si existe)", () => {
    const s = texto(buildDetalleConditions({ businessId: 7, year: 2026, sinProveedor: false, conceptoCodigo: "9" }));
    expect(s).toContain('COALESCE(c."conceptoCodigoManual", c."conceptoCodigo")');
  });
  it("histórico no acota por fecha", () => {
    const s = texto(buildDetalleConditions({ businessId: 7, year: 2026, sinProveedor: false, historico: true }));
    expect(s.includes('COALESCE(c."fechaManual", c.fecha) >=')).toBe(false);
  });
});
