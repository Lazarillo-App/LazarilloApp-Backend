// Portado de lazarillo_gestion/lib/dashboard/pivot-por-proveedor.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { buildPivotDataByProveedor } = require('./pivot-por-proveedor');

function row(overrides) {
  return {
    rubro_codigo: "R1", rubro_nombre: "Rubro 1",
    concepto_codigo: "C1", concepto_nombre: "Concepto 1",
    proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_texto_crudo: null, proveedor_codigo: "P1",
    mes: 1, total: 100, row_id: "row-1", distribucion_id: null,
    fecha: "2026-01-01", observac: null, has_manual_override: false,
    business_id_origen: null, branch_id_origen: null,
    ...overrides,
  };
}

describe("buildPivotDataByProveedor", () => {
  it("agrupa por rubro, luego proveedor, luego concepto, sin mezclar proveedores", () => {
    const rows = [
      row({ proveedor_id: 1, proveedor_nombre: "Proveedor A", concepto_codigo: "C1", row_id: "a1", total: 100 }),
      row({ proveedor_id: 2, proveedor_nombre: "Proveedor B", concepto_codigo: "C1", row_id: "b1", total: 200 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});

    expect(data.rows).toHaveLength(1);
    const rubro = data.rows[0];
    expect(rubro.children).toHaveLength(2);
    const provA = rubro.children.find((p) => p.proveedorId === 1);
    const provB = rubro.children.find((p) => p.proveedorId === 2);
    expect(provA.rowTotal).toBe(100);
    expect(provB.rowTotal).toBe(200);
    expect(provA.children).toHaveLength(1);
    expect(provA.children[0].conceptoCodigo).toBe("C1");
    expect(provA.children[0].rowTotal).toBe(100);
  });

  it("un proveedor con compras en dos rubros aparece duplicado, uno por rubro, sin mezclar importes", () => {
    const rows = [
      row({ rubro_codigo: "R1", rubro_nombre: "Rubro 1", proveedor_id: 1, concepto_codigo: "C1", row_id: "a1", total: 100 }),
      row({ rubro_codigo: "R2", rubro_nombre: "Rubro 2", proveedor_id: 1, concepto_codigo: "C2", concepto_nombre: "Concepto 2", row_id: "a2", total: 300 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});

    expect(data.rows).toHaveLength(2);
    const rubro1 = data.rows.find((r) => r.rubroCodigo === "R1");
    const rubro2 = data.rows.find((r) => r.rubroCodigo === "R2");
    expect(rubro1.children).toHaveLength(1);
    expect(rubro2.children).toHaveLength(1);
    expect(rubro1.children[0].proveedorId).toBe(1);
    expect(rubro2.children[0].proveedorId).toBe(1);
    expect(rubro1.children[0].rowTotal).toBe(100);
    expect(rubro2.children[0].rowTotal).toBe(300);
    expect(rubro1.children[0].id).not.toBe(rubro2.children[0].id);
    expect(data.grandTotal).toBe(400);
  });

  it("rollup mensual correcto en proveedor y rubro, y en los totales generales", () => {
    const rows = [
      row({ proveedor_id: 1, concepto_codigo: "C1", row_id: "a1", mes: 1, total: 100 }),
      row({ proveedor_id: 1, concepto_codigo: "C2", concepto_nombre: "Concepto 2", row_id: "a2", mes: 1, total: 50 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    const rubro = data.rows[0];
    const provA = rubro.children[0];
    expect(provA.values[1]).toBe(150);
    expect(provA.rowTotal).toBe(150);
    expect(rubro.values[1]).toBe(150);
    expect(rubro.rowTotal).toBe(150);
    expect(data.columnTotals[1]).toBe(150);
    expect(data.grandTotal).toBe(150);
  });

  it("proveedor_id null: usa el texto crudo del ERP como nombre del grupo, no un label sentinela", () => {
    const rows = [
      row({ proveedor_id: null, proveedor_nombre: "Diego", proveedor_texto_crudo: "Diego", row_id: "x1", total: 10 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    const proveedor = data.rows[0].children[0];
    expect(proveedor.proveedorId).toBeNull();
    expect(proveedor.nombre).toBe("Diego");
    expect(proveedor.proveedorTexto).toBe("Diego");
  });

  it("entidadIdProveedor: con proveedor_id usa el id como string", () => {
    const rows = [
      row({ proveedor_id: 7, proveedor_nombre: "Proveedor G", row_id: "a1", total: 10 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    expect(data.rows[0].children[0].entidadIdProveedor).toBe("7");
  });

  it("entidadIdProveedor: sin proveedor_id y sin codigo usa 'texto:<normalizado>' del proveedor_nombre", () => {
    const rows = [
      row({ proveedor_id: null, proveedor_nombre: "Diego", proveedor_texto_crudo: "Diego", proveedor_codigo: null, row_id: "x1", total: 10 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    expect(data.rows[0].children[0].entidadIdProveedor).toBe("texto:diego");
  });

  it("entidadIdProveedor: nodo genuino Sin Proveedor sin codigo usa 'texto:sinproveedor'", () => {
    const rows = [
      row({ proveedor_id: null, proveedor_nombre: "Sin Proveedor", proveedor_texto_crudo: null, proveedor_codigo: null, row_id: "x1", total: 10 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    expect(data.rows[0].children[0].entidadIdProveedor).toBe("texto:sinproveedor");
  });

  it("propaga codigo y rubroCodigo al nodo de proveedor", () => {
    const rows = [
      row({ rubro_codigo: "3", proveedor_id: 608, proveedor_nombre: "Santiago Benjamin", proveedor_codigo: "608", row_id: "a1", total: 10 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    const proveedor = data.rows[0].children[0];
    expect(proveedor.codigo).toBe("608");
    expect(proveedor.rubroCodigo).toBe("3");
  });

  it("sin proveedor real, codigo llega null si la compra no trae codigo", () => {
    const rows = [
      row({ proveedor_id: null, proveedor_nombre: "Diego", proveedor_texto_crudo: "Diego", proveedor_codigo: null, row_id: "x1", total: 10 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    expect(data.rows[0].children[0].codigo).toBeNull();
  });

  it("dos personas con el mismo nombre pero codigo distinto: dos nodos separados, no se mezcla la plata", () => {
    const rows = [
      row({ proveedor_id: null, proveedor_nombre: "Abril", proveedor_texto_crudo: "Abril", proveedor_codigo: "368", row_id: "a1", total: 100 }),
      row({ proveedor_id: null, proveedor_nombre: "Abril", proveedor_texto_crudo: "Abril", proveedor_codigo: "670", row_id: "a2", total: 50 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    const rubro = data.rows[0];
    expect(rubro.children).toHaveLength(2);
    const abril368 = rubro.children.find((p) => p.codigo === "368");
    const abril670 = rubro.children.find((p) => p.codigo === "670");
    expect(abril368.rowTotal).toBe(100);
    expect(abril670.rowTotal).toBe(50);
    expect(abril368.entidadIdProveedor).toBe("texto:abril|codigo:368");
    expect(abril670.entidadIdProveedor).toBe("texto:abril|codigo:670");
  });

  it("Sin Proveedor (balde genuino) no se fragmenta por codigo aunque la compra traiga uno", () => {
    const rows = [
      row({ proveedor_id: null, proveedor_nombre: "Sin Proveedor", proveedor_texto_crudo: null, proveedor_codigo: "999", row_id: "x1", total: 10 }),
      row({ proveedor_id: null, proveedor_nombre: "Sin Proveedor", proveedor_texto_crudo: null, proveedor_codigo: "888", row_id: "x2", total: 20 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    expect(data.rows[0].children).toHaveLength(1);
    expect(data.rows[0].children[0].entidadIdProveedor).toBe("texto:sinproveedor");
    expect(data.rows[0].children[0].rowTotal).toBe(30);
  });

  it("mismo nombre y mismo codigo en filas distintas: se siguen sumando en un solo nodo", () => {
    const rows = [
      row({ proveedor_id: null, proveedor_nombre: "Abril", proveedor_texto_crudo: "Abril", proveedor_codigo: "368", row_id: "a1", total: 100 }),
      row({ proveedor_id: null, proveedor_nombre: "Abril", proveedor_texto_crudo: "Abril", proveedor_codigo: "368", row_id: "a2", total: 50 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    expect(data.rows[0].children).toHaveLength(1);
    expect(data.rows[0].children[0].rowTotal).toBe(150);
  });

  it("proveedor real (proveedorId no null): entidadIdProveedor sigue siendo solo el id, sin sufijo de codigo", () => {
    const rows = [
      row({ proveedor_id: 7, proveedor_nombre: "Proveedor G", proveedor_codigo: "7", row_id: "a1", total: 10 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    expect(data.rows[0].children[0].entidadIdProveedor).toBe("7");
  });

  it("dos textos crudos distintos sin proveedor real: dos nodos separados, no se mezclan", () => {
    const rows = [
      row({ proveedor_id: null, proveedor_nombre: "Diego", proveedor_texto_crudo: "Diego", row_id: "x1", total: 10 }),
      row({ proveedor_id: null, proveedor_nombre: "GASTOS VARIOS", proveedor_texto_crudo: "GASTOS VARIOS", row_id: "x2", total: 20 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    const rubro = data.rows[0];
    expect(rubro.children).toHaveLength(2);
    const diego = rubro.children.find((p) => p.nombre === "Diego");
    const gastosVarios = rubro.children.find((p) => p.nombre === "GASTOS VARIOS");
    expect(diego.rowTotal).toBe(10);
    expect(gastosVarios.rowTotal).toBe(20);
    // El filtro de drill-down de cada nodo sale del texto crudo, no del COALESCE.
    expect(diego.proveedorTexto).toBe("Diego");
    expect(gastosVarios.proveedorTexto).toBe("GASTOS VARIOS");
  });

  it("mismo texto crudo con mayúsculas/tildes distintas: mismo nodo (agrupa normalizado)", () => {
    const rows = [
      row({ proveedor_id: null, proveedor_nombre: "Agustín", proveedor_texto_crudo: "Agustín", row_id: "x1", total: 10 }),
      row({ proveedor_id: null, proveedor_nombre: "AGUSTIN", proveedor_texto_crudo: "AGUSTIN", row_id: "x2", total: 15 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    const rubro = data.rows[0];
    expect(rubro.children).toHaveLength(1);
    expect(rubro.children[0].rowTotal).toBe(25);
    // El label mostrado es el texto de la PRIMERA fila vista de ese grupo, no una forma normalizada.
    expect(rubro.children[0].nombre).toBe("Agustín");
  });

  it("sin proveedor ni texto crudo (el literal 'Sin Proveedor' de la SQL): cae en su propio grupo, separado de cualquier texto real", () => {
    const rows = [
      // Así llega la fila real: la columna cruda es null y el COALESCE de la SQL
      // cae al literal 'Sin Proveedor' para el label.
      row({ proveedor_id: null, proveedor_nombre: "Sin Proveedor", proveedor_texto_crudo: null, row_id: "x1", total: 5 }),
      row({ proveedor_id: null, proveedor_nombre: "Diego", proveedor_texto_crudo: "Diego", row_id: "x2", total: 10 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    const rubro = data.rows[0];
    expect(rubro.children).toHaveLength(2);
    const sinDatos = rubro.children.find((p) => p.nombre === "Sin Proveedor");
    const diego = rubro.children.find((p) => p.nombre === "Diego");
    expect(sinDatos.rowTotal).toBe(5);
    expect(diego.rowTotal).toBe(10);
    // Sin texto crudo, proveedorTexto debe ser null para que la UI mande
    // sinProveedor:true al drill-down (y no el literal del COALESCE, que no
    // coincide con ninguna fila real de c.proveedor).
    expect(sinDatos.proveedorTexto).toBeNull();
    expect(sinDatos.children[0].proveedorTexto).toBeNull();
    expect(diego.proveedorTexto).toBe("Diego");
    expect(diego.children[0].proveedorTexto).toBe("Diego");
  });

  it("proveedor real (proveedor_id no null): proveedorTexto queda null", () => {
    const rows = [row({ proveedor_id: 1, proveedor_nombre: "Proveedor A", row_id: "a1" })];
    const data = buildPivotDataByProveedor(rows, {});
    expect(data.rows[0].children[0].proveedorTexto).toBeNull();
  });

  it("adjunta la composición correspondiente a cada concepto+proveedor, sin importar el rubro", () => {
    const rows = [row({ proveedor_id: 1, concepto_codigo: "C1", row_id: "a1" })];
    const composicion = { "C1|1": { 1: { total: 100, destinos: [{ nombre: "Local A", pct: 100, importe: 100 }] } } };
    const data = buildPivotDataByProveedor(rows, composicion);
    expect(data.rows[0].children[0].children[0].composicion).toEqual(composicion["C1|1"]);
  });

  it("dos líneas de la misma compra distribuida no colisionan de id", () => {
    const rows = [
      row({ proveedor_id: 1, concepto_codigo: "C1", row_id: "a1", distribucion_id: 10, total: 60 }),
      row({ proveedor_id: 1, concepto_codigo: "C1", row_id: "a1", distribucion_id: 11, total: 40 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    const lineaIds = data.rows[0].children[0].children[0].children.map((l) => l.id);
    expect(new Set(lineaIds).size).toBe(2);
  });

  it("un único concepto con composicion y cobertura total: el proveedor hereda la misma composicion del mes, sin bucket 'Sin apertura'", () => {
    const rows = [row({ proveedor_id: 1, concepto_codigo: "C1", row_id: "a1", mes: 1, total: 100 })];
    const composicion = { "C1|1": { 1: { total: 100, destinos: [{ nombre: "Local A", pct: 100, importe: 100 }] } } };
    const data = buildPivotDataByProveedor(rows, composicion);
    const proveedor = data.rows[0].children[0];
    expect(proveedor.composicion?.[1]).toEqual({ total: 100, destinos: [{ nombre: "Local A", pct: 100, importe: 100 }] });
  });

  it("dos conceptos bajo el mismo proveedor, solo uno con composicion: el total del proveedor agrega bucket 'Sin apertura' con el resto", () => {
    const rows = [
      row({ proveedor_id: 1, concepto_codigo: "C1", row_id: "a1", mes: 2, total: 110 }),
      row({ proveedor_id: 1, concepto_codigo: "C2", concepto_nombre: "Concepto 2", row_id: "a2", mes: 2, total: 918367 }),
    ];
    const composicion = {
      "C1|1": { 2: { total: 110, destinos: [{ nombre: "Ramos Mejía — Bar", pct: 70, importe: 77 }, { nombre: "Ramos Mejía — Canchas", pct: 30, importe: 33 }] } },
    };
    const data = buildPivotDataByProveedor(rows, composicion);
    const proveedor = data.rows[0].children[0];
    expect(proveedor.values[2]).toBe(918477);
    expect(proveedor.composicion?.[2]).toEqual({
      total: 918477,
      destinos: [
        { nombre: "Ramos Mejía — Bar", pct: (77 / 918477) * 100, importe: 77 },
        { nombre: "Ramos Mejía — Canchas", pct: (33 / 918477) * 100, importe: 33 },
        { nombre: "Sin apertura", pct: (918367 / 918477) * 100, importe: 918367 },
      ],
    });
  });

  it("composicionTotal del concepto agrega su propia composicion mensual a lo largo del año", () => {
    const rows = [
      row({ proveedor_id: 1, concepto_codigo: "C1", row_id: "a1", mes: 1, total: 100 }),
      row({ proveedor_id: 1, concepto_codigo: "C1", row_id: "a2", mes: 2, total: 50 }),
    ];
    const composicion = {
      "C1|1": {
        1: { total: 100, destinos: [{ nombre: "Local A", pct: 100, importe: 100 }] },
        2: { total: 50, destinos: [{ nombre: "Local A", pct: 100, importe: 50 }] },
      },
    };
    const data = buildPivotDataByProveedor(rows, composicion);
    const concepto = data.rows[0].children[0].children[0];
    expect(concepto.composicionTotal).toEqual({ total: 150, destinos: [{ nombre: "Local A", pct: 100, importe: 150 }] });
  });

  it("composicionTotal del proveedor agrega los composicionTotal de sus conceptos hijos", () => {
    const rows = [
      row({ proveedor_id: 1, concepto_codigo: "C1", row_id: "a1", mes: 1, total: 100 }),
      row({ proveedor_id: 1, concepto_codigo: "C2", concepto_nombre: "Concepto 2", row_id: "a2", mes: 1, total: 50 }),
    ];
    const composicion = {
      "C1|1": { 1: { total: 100, destinos: [{ nombre: "Local A", pct: 100, importe: 100 }] } },
    };
    const data = buildPivotDataByProveedor(rows, composicion);
    const proveedor = data.rows[0].children[0];
    expect(proveedor.composicionTotal).toEqual({
      total: 150,
      destinos: [
        { nombre: "Local A", pct: (100 / 150) * 100, importe: 100 },
        { nombre: "Sin apertura", pct: (50 / 150) * 100, importe: 50 },
      ],
    });
  });

  it("con filtro de PDV activo, composicion.total del concepto (reparto completo sin filtrar) puede superar su values filtrado: el proveedor no genera pct > 100%", () => {
    // Reproduce el bug reportado: con el dashboard filtrado a un PDV (ej.
    // "Canchas"), la fila trae solo el importe destinado a ESE PDV ($1.155.000),
    // pero composicion.total sigue siendo el reparto completo sin filtrar
    // (Bar $2.695.000 + Canchas $1.155.000 = $3.850.000, por diseño de
    // app/api/dashboard/pivot/route.ts). mergeComposiciones no debe comparar
    // ambas bases ni generar destinos con pct > 100%.
    const rows = [row({ proveedor_id: 1, concepto_codigo: "C1", row_id: "a1", mes: 1, total: 1155000 })];
    const composicion = {
      "C1|1": {
        1: {
          total: 3850000,
          destinos: [
            { nombre: "Ramos Mejía — Bar", pct: 70, importe: 2695000 },
            { nombre: "Ramos Mejía — Canchas", pct: 30, importe: 1155000 },
          ],
        },
      },
    };
    const data = buildPivotDataByProveedor(rows, composicion);
    const proveedor = data.rows[0].children[0];
    expect(proveedor.composicion?.[1]).toEqual({
      total: 3850000,
      destinos: [
        { nombre: "Ramos Mejía — Bar", pct: 70, importe: 2695000 },
        { nombre: "Ramos Mejía — Canchas", pct: 30, importe: 1155000 },
      ],
    });
    expect(proveedor.composicion?.[1]?.destinos.every((d) => d.pct <= 100)).toBe(true);
  });

  it("proveedor sin ningún concepto con composicion: no arma composicion ni composicionTotal", () => {
    const rows = [row({ proveedor_id: 1, concepto_codigo: "C1", row_id: "a1", mes: 1, total: 100 })];
    const data = buildPivotDataByProveedor(rows, {});
    const proveedor = data.rows[0].children[0];
    expect(proveedor.composicion).toBeUndefined();
    expect(proveedor.composicionTotal).toBeUndefined();
  });

  it("GASTOS VARIOS no se fragmenta por codigo: un solo nodo con sus conceptos debajo, sin codigo para el drill-down", () => {
    const rows = [
      row({ proveedor_id: null, proveedor_nombre: "GASTOS VARIOS", proveedor_texto_crudo: "GASTOS VARIOS", proveedor_codigo: "101", concepto_codigo: "C1", row_id: "g1", total: 10 }),
      row({ proveedor_id: null, proveedor_nombre: "GASTOS VARIOS", proveedor_texto_crudo: "GASTOS VARIOS", proveedor_codigo: "102", concepto_codigo: "C2", concepto_nombre: "Concepto 2", row_id: "g2", total: 20 }),
      row({ proveedor_id: null, proveedor_nombre: "GASTOS VARIOS", proveedor_texto_crudo: "GASTOS VARIOS", proveedor_codigo: "103", concepto_codigo: "C2", concepto_nombre: "Concepto 2", row_id: "g3", total: 5 }),
    ];
    const data = buildPivotDataByProveedor(rows, {});
    expect(data.rows[0].children).toHaveLength(1);
    const proveedor = data.rows[0].children[0];
    expect(proveedor.entidadIdProveedor).toBe("texto:gastosvarios");
    expect(proveedor.rowTotal).toBe(35);
    expect(proveedor.children.map((c) => c.conceptoCodigo)).toEqual(["C1", "C2"]);
    // El código de una sola compra filtraría el drill-down a esa compra y el modal no sumaría lo de la celda.
    expect(proveedor.codigo).toBeNull();
    expect(proveedor.children.every((c) => c.codigo === null)).toBe(true);
  });
});
