// Portado de lazarillo_gestion/lib/dashboard/query-builders.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { buildPivotConditions, observacionCondition, importeCondition, sinRubroVisibleSql } = require('./query-builders');

const sqlDe = (conds) => conds.map((c) => c.sql).join(" AND ");

// En Lazarillo el negocio es obligatorio (ver query-builders.js): los casos de gestion
// se corren sobre un negocio fijo.
const pc = (o) => buildPivotConditions({ businessId: 147, ...o });

describe("buildPivotConditions — año", () => {
  it("con año filtra por ese año como rango, para que use los índices de fecha", () => {
    const conds = pc({ year: 2025, tableAlias: "c" });
    const sql = sqlDe(conds);
    expect(sql).toContain(`COALESCE(c."fechaManual", c.fecha) >= `);
    expect(sql).toContain(`COALESCE(c."fechaManual", c.fecha) < `);
    expect(sql).not.toContain("EXTRACT(YEAR FROM");
    expect(conds.flatMap((c) => c.values)).toEqual(expect.arrayContaining(["2025-01-01", "2026-01-01"]));
  });

  it("ventas (sin fecha manual): rango sobre v.fecha", () => {
    const sql = sqlDe(pc({ year: 2025, tableAlias: "v", hasFechaManual: false }));
    expect(sql).toContain("v.fecha >= ");
    expect(sql).not.toContain("fechaManual");
  });

  it("sin año no filtra por año: la búsqueda recorre todos los años", () => {
    const sql = sqlDe(pc({ tableAlias: "c" }));
    expect(sql).not.toContain("EXTRACT(YEAR FROM");
    expect(sql).not.toContain("::timestamp");
  });

  it("sin año igual exige fecha e importe efectivos distintos de 0", () => {
    const sql = sqlDe(pc({ tableAlias: "c" }));
    expect(sql).toContain(`"fechaManual" IS NOT NULL`);
    expect(sql).toContain("!= 0");
  });
});

describe("buildPivotConditions — observación", () => {
  it("busca por contenido ignorando acentos en la observación efectiva", () => {
    const conds = pc({ tableAlias: "c", observacionQuery: "eléctrico" });
    expect(sqlDe(conds)).toContain(`translate(COALESCE(c."observacManual", c.observac),`);
    expect(sqlDe(conds)).toContain("ILIKE");
    expect(conds.flatMap((c) => c.values)).toContain("%electrico%");
  });

  it("escapa los comodines de LIKE tipeados por el usuario", () => {
    const conds = pc({ tableAlias: "c", observacionQuery: "50%_a" });
    expect(conds.flatMap((c) => c.values)).toContain("%50\\%\\_a%");
  });
});

// En gestion: "origen" = local / PDV opcionales. En Lazarillo: negocio obligatorio + sucursal opcional.
describe("buildPivotConditions — negocio y sucursal", () => {
  it("sin negocio no arma la consulta (nunca ver datos de todos los negocios)", () => {
    let error = null;
    try { buildPivotConditions({ tableAlias: "c" }); } catch (e) { error = e; }
    expect(error?.message).toContain("businessId");
  });

  it("sin sucursal: todo el negocio", () => {
    const conds = pc({ tableAlias: "c" });
    const sql = sqlDe(conds);
    expect(sql).toContain(`c.business_id =`);
    expect(sql).not.toContain("branch_id");
    expect(conds.flatMap((c) => c.values)).toContain(147);
  });

  it("sucursal null: solo la principal", () => {
    expect(sqlDe(pc({ tableAlias: "c", sucursal: null }))).toContain("c.branch_id IS NULL");
  });

  it("sucursal número: solo esa sucursal", () => {
    const conds = pc({ tableAlias: "c", sucursal: 15 });
    expect(sqlDe(conds)).toContain("c.branch_id =");
    expect(conds.flatMap((c) => c.values)).toEqual(expect.arrayContaining([147, 15]));
  });
});

describe("buildPivotConditions — visibilidad de Sin Rubro", () => {
  it("Compras: consulta sin_rubro_config con la columna del dashboard y default true", () => {
    const sql = sqlDe(pc({ tableAlias: "c", filterRubrosOcultos: true }));
    expect(sql).toContain("gestion_sin_rubro_config");
    expect(sql).toContain("s.business_id =");
    expect(sql).toContain(`s."visibleEnDashboard"`);
    expect(sql).toMatch(/,\s*true\)/);
  });

  it("Resultados: consulta la columna de resultados y default false", () => {
    const sql = sqlDe(pc({ tableAlias: "c", filterRubrosOcultos: true, visibilidadCol: "visibleEnResultados" }));
    expect(sql).toContain(`s."visibleEnResultados"`);
    expect(sql).not.toContain(`s."visibleEnDashboard"`);
    expect(sql).toMatch(/,\s*false\)/);
  });

  it("los rubros reales usan la visibilidad del negocio (rv), con el default de gestion", () => {
    expect(sqlDe(pc({ tableAlias: "c", filterRubrosOcultos: true }))).toContain(`COALESCE(rv."visibleEnDashboard", true)`);
    expect(sqlDe(pc({ tableAlias: "c", filterRubrosOcultos: true, visibilidadCol: "visibleEnResultados" }))).toContain(`COALESCE(rv."visibleEnResultados", false)`);
  });

  it("ya no deja Sin Rubro incondicionalmente visible (rc.codigo IS NULL va atado al flag)", () => {
    const sql = sqlDe(pc({ tableAlias: "c", filterRubrosOcultos: true }));
    expect(sql).toContain("rc.codigo IS NULL AND");
  });

  it("sin filterRubrosOcultos no consulta la config", () => {
    expect(sqlDe(pc({ tableAlias: "c" }))).not.toContain("sin_rubro_config");
  });

  it("con rubroCodigo explícito no consulta la config (el usuario pidió ese bucket)", () => {
    const sql = sqlDe(pc({ tableAlias: "c", filterRubrosOcultos: true, rubroCodigo: "__sin_rubro" }));
    expect(sql).not.toContain("sin_rubro_config");
  });
});

describe("sinRubroVisibleSql", () => {
  it("una columna fuera de la whitelist cae al dashboard, nunca se interpola cruda", () => {
    const frag = sinRubroVisibleSql("x; DROP TABLE compras", 147);
    expect(frag.sql).toContain(`s."visibleEnDashboard"`);
    expect(frag.sql).not.toContain("DROP");
  });
});

describe("observacionCondition", () => {
  it("compara la observación efectiva sin acentos, con los comodines escapados", () => {
    const cond = observacionCondition("c", "Eléctrico 50%_a");
    expect(cond.sql).toContain(`translate(COALESCE(c."observacManual", c.observac),`);
    expect(cond.sql).toContain("ILIKE");
    expect(cond.values).toContain("%Electrico 50\\%\\_a%");
  });

  it("escapa también la barra invertida", () => {
    expect(observacionCondition("c", "a\\b").values).toContain("%a\\\\b%");
  });
});

describe("importeCondition / buildPivotConditions — importe (punto 9 Etapa 3)", () => {
  it("sin centavos: parte entera, por subconsulta sobre compras (importe completo, no la parte distribuida)", () => {
    const cond = importeCondition("c", "811.980");
    expect(cond).not.toBeNull();
    expect(cond.sql).toContain(`c."rowId" IN (SELECT co."rowId" FROM gestion_compras co WHERE`);
    expect(cond.sql).toContain(`ABS(COALESCE(co."importeManual", co.importe)) >=`);
    expect(cond.sql).toContain("<");
    expect(cond.values.map(String)).toEqual(["811980", "811981"]);
  });

  it("con centavos: igualdad exacta", () => {
    const cond = importeCondition("c", "811.980,50");
    expect(cond.sql).toContain(`ABS(COALESCE(co."importeManual", co.importe)) =`);
    expect(cond.values.map(String)).toEqual(["811980.5"]);
  });

  it("texto que no es un importe → null, y buildPivotConditions lo ignora sin romper", () => {
    expect(importeCondition("c", "coca")).toBeNull();
    const sql = pc({ tableAlias: "c", importeQuery: "coca" }).map((c) => c.sql).join(" AND ");
    expect(sql).not.toContain("compras co");
  });

  it("buildPivotConditions agrega la condición cuando importeQuery parsea", () => {
    const sql = pc({ tableAlias: "c", importeQuery: "200000" }).map((c) => c.sql).join(" AND ");
    expect(sql).toContain(`c."rowId" IN (SELECT co."rowId" FROM gestion_compras co WHERE`);
  });
});
