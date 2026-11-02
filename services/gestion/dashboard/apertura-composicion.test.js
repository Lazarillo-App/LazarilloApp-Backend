// Portado de lazarillo_gestion/lib/dashboard/apertura-composicion.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { buildComposicion, buildComposicionPorProveedor, mergeComposiciones } = require('./apertura-composicion');

describe("buildComposicion", () => {
  it("agrupa por concepto+mes y arma la lista de destinos con pct e importe", () => {
    const destinoRows = [
      { concepto_codigo: "17", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 5, destino_nombre: "Actual", pct: 70, importe_calculado: 73993 },
      { concepto_codigo: "17", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 5, destino_nombre: "Canchas Ramos", pct: 10, importe_calculado: 10570 },
      { concepto_codigo: "17", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 5, destino_nombre: "Canchas SJ", pct: 10, importe_calculado: 10570 },
      { concepto_codigo: "17", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 5, destino_nombre: "Descartado", pct: 10, importe_calculado: 10571 },
    ];
    const originalRows = [{ concepto_codigo: "17", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 5, importe_original: 105704 }];
    const result = buildComposicion(destinoRows, originalRows);
    expect(result["17"][5].total).toBe(105704);
    expect(result["17"][5].destinos).toHaveLength(4);
    expect(result["17"][5].destinos[0]).toEqual({ nombre: "Actual", pct: 70, importe: 73993 });
  });

  it("convierte Decimal-like (string) a number", () => {
    const result = buildComposicion(
      [{ concepto_codigo: "3", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 1, destino_nombre: "X", pct: "50.00", importe_calculado: "1000.00" }],
      [{ concepto_codigo: "3", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 1, importe_original: "2000.00" }]
    );
    expect(result["3"][1].destinos[0]).toEqual({ nombre: "X", pct: 50, importe: 1000 });
    expect(result["3"][1].total).toBe(2000);
  });

  it("concepto+mes sin fila de original: total 0 (no rompe)", () => {
    const result = buildComposicion(
      [{ concepto_codigo: "9", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 2, destino_nombre: "X", pct: 100, importe_calculado: 5 }],
      []
    );
    expect(result["9"][2].total).toBe(0);
  });

  it("fusiona destinos con mismo nombre+pct cuando la SQL llega particionada por proveedor, sumando el importe", () => {
    const destinoRows = [
      { concepto_codigo: "17", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 5, destino_nombre: "Actual", pct: 70, importe_calculado: 40000 },
      { concepto_codigo: "17", proveedor_id: 2, proveedor_nombre: "Proveedor B", proveedor_codigo: null, mes: 5, destino_nombre: "Actual", pct: 70, importe_calculado: 33993 },
    ];
    const originalRows = [{ concepto_codigo: "17", proveedor_id: null, proveedor_nombre: "Sin Proveedor", proveedor_codigo: "700", mes: 5, importe_original: 105704 }];
    const result = buildComposicion(destinoRows, originalRows);
    expect(result["17"][5].destinos).toHaveLength(1);
    expect(result["17"][5].destinos[0]).toEqual({ nombre: "Actual", pct: 70, importe: 73993 });
  });
});

describe("buildComposicionPorProveedor", () => {
  it("agrupa por concepto+proveedor+mes, sin mezclar proveedores", () => {
    const destinoRows = [
      { concepto_codigo: "17", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 5, destino_nombre: "Actual", pct: 70, importe_calculado: 700 },
      { concepto_codigo: "17", proveedor_id: 2, proveedor_nombre: "Proveedor B", proveedor_codigo: null, mes: 5, destino_nombre: "Actual", pct: 50, importe_calculado: 500 },
    ];
    const originalRows = [
      { concepto_codigo: "17", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 5, importe_original: 1000 },
      { concepto_codigo: "17", proveedor_id: 2, proveedor_nombre: "Proveedor B", proveedor_codigo: null, mes: 5, importe_original: 1000 },
    ];
    const result = buildComposicionPorProveedor(destinoRows, originalRows);

    expect(result["17|1"][5].total).toBe(1000);
    expect(result["17|1"][5].destinos).toEqual([{ nombre: "Actual", pct: 70, importe: 700 }]);
    expect(result["17|2"][5].destinos).toEqual([{ nombre: "Actual", pct: 50, importe: 500 }]);
  });

  it("proveedor_id null: usa el texto crudo normalizado como clave, no un sentinela fijo", () => {
    const result = buildComposicionPorProveedor(
      [{ concepto_codigo: "3", proveedor_id: null, proveedor_nombre: "Diego", proveedor_codigo: "120", mes: 1, destino_nombre: "X", pct: 100, importe_calculado: 500 }],
      [{ concepto_codigo: "3", proveedor_id: null, proveedor_nombre: "Diego", proveedor_codigo: "120", mes: 1, importe_original: 500 }]
    );
    expect(result["3|texto:diego|codigo:120"][1].total).toBe(500);
  });

  it("dos textos crudos distintos sin proveedor real, mismo concepto: NO se mezclan en la misma composición", () => {
    const destinoRows = [
      { concepto_codigo: "3", proveedor_id: null, proveedor_nombre: "Diego", proveedor_codigo: "120", mes: 1, destino_nombre: "Local A", pct: 100, importe_calculado: 100 },
      { concepto_codigo: "3", proveedor_id: null, proveedor_nombre: "GASTOS VARIOS", proveedor_codigo: "555", mes: 1, destino_nombre: "Local B", pct: 100, importe_calculado: 200 },
    ];
    const originalRows = [
      { concepto_codigo: "3", proveedor_id: null, proveedor_nombre: "Diego", proveedor_codigo: "120", mes: 1, importe_original: 100 },
      { concepto_codigo: "3", proveedor_id: null, proveedor_nombre: "GASTOS VARIOS", proveedor_codigo: "555", mes: 1, importe_original: 200 },
    ];
    const result = buildComposicionPorProveedor(destinoRows, originalRows);
    expect(result["3|texto:diego|codigo:120"][1].destinos).toEqual([{ nombre: "Local A", pct: 100, importe: 100 }]);
    // GASTOS VARIOS es balde genérico: su clave no lleva código (ver BALDES_SIN_CODIGO).
    expect(result["3|texto:gastosvarios"][1].destinos).toEqual([{ nombre: "Local B", pct: 100, importe: 200 }]);
  });

  it("mismo nombre, codigo distinto: NO se mezclan en la misma composición", () => {
    const destinoRows = [
      { concepto_codigo: "3", proveedor_id: null, proveedor_nombre: "Abril", proveedor_codigo: "368", mes: 1, destino_nombre: "Local A", pct: 100, importe_calculado: 100 },
      { concepto_codigo: "3", proveedor_id: null, proveedor_nombre: "Abril", proveedor_codigo: "670", mes: 1, destino_nombre: "Local B", pct: 100, importe_calculado: 200 },
    ];
    const originalRows = [
      { concepto_codigo: "3", proveedor_id: null, proveedor_nombre: "Abril", proveedor_codigo: "368", mes: 1, importe_original: 100 },
      { concepto_codigo: "3", proveedor_id: null, proveedor_nombre: "Abril", proveedor_codigo: "670", mes: 1, importe_original: 200 },
    ];
    const result = buildComposicionPorProveedor(destinoRows, originalRows);
    expect(result["3|texto:abril|codigo:368"][1].destinos).toEqual([{ nombre: "Local A", pct: 100, importe: 100 }]);
    expect(result["3|texto:abril|codigo:670"][1].destinos).toEqual([{ nombre: "Local B", pct: 100, importe: 200 }]);
  });

  it("proveedor_id null y sin codigo: clave sin sufijo, igual que antes", () => {
    const result = buildComposicionPorProveedor(
      [{ concepto_codigo: "3", proveedor_id: null, proveedor_nombre: "GASTOS VARIOS", proveedor_codigo: null, mes: 1, destino_nombre: "X", pct: 100, importe_calculado: 10 }],
      [{ concepto_codigo: "3", proveedor_id: null, proveedor_nombre: "GASTOS VARIOS", proveedor_codigo: null, mes: 1, importe_original: 10 }]
    );
    expect(result["3|texto:gastosvarios"][1].total).toBe(10);
  });

  it("Sin Proveedor no se fragmenta por codigo en el tooltip tampoco", () => {
    const result = buildComposicionPorProveedor(
      [{ concepto_codigo: "3", proveedor_id: null, proveedor_nombre: "Sin Proveedor", proveedor_codigo: "999", mes: 1, destino_nombre: "X", pct: 100, importe_calculado: 10 }],
      [{ concepto_codigo: "3", proveedor_id: null, proveedor_nombre: "Sin Proveedor", proveedor_codigo: "999", mes: 1, importe_original: 10 }]
    );
    expect(result["3|texto:sinproveedor"][1].total).toBe(10);
  });

  it("no afecta a buildComposicion existente (sigue agrupando solo por concepto)", () => {
    const result = buildComposicion(
      [{ concepto_codigo: "17", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 5, destino_nombre: "Actual", pct: 70, importe_calculado: 700 }],
      [{ concepto_codigo: "17", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 5, importe_original: 1000 }]
    );
    expect(result["17"][5].total).toBe(1000);
  });

  it("NO fusiona dos destinos distintos del mismo bucket (concepto+proveedor+mes) aunque compartan pct", () => {
    const destinoRows = [
      { concepto_codigo: "17", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 5, destino_nombre: "Actual", pct: 70, importe_calculado: 700 },
      { concepto_codigo: "17", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 5, destino_nombre: "Canchas Ramos", pct: 70, importe_calculado: 300 },
    ];
    const originalRows = [{ concepto_codigo: "17", proveedor_id: 1, proveedor_nombre: "Proveedor A", proveedor_codigo: null, mes: 5, importe_original: 1000 }];
    const result = buildComposicionPorProveedor(destinoRows, originalRows);

    expect(result["17|1"][5].destinos).toHaveLength(2);
    expect(result["17|1"][5].destinos).toEqual([
      { nombre: "Actual", pct: 70, importe: 700 },
      { nombre: "Canchas Ramos", pct: 70, importe: 300 },
    ]);
  });

  it("fusiona el mismo destino de un proveedor real fragmentado en varios proveedor_nombre (maestro sin nombre ni razón)", () => {
    // Un proveedor real cuyo registro maestro no tiene nombre NI razón hace que
    // el COALESCE de la SQL caiga a c.proveedor, que varía fila a fila: el
    // GROUP BY por proveedor_nombre parte un único proveedor_id en varias filas.
    const destinoRows = [
      { concepto_codigo: "17", proveedor_id: 5, proveedor_nombre: "Diego", proveedor_codigo: null, mes: 5, destino_nombre: "Actual", pct: 70, importe_calculado: 400 },
      { concepto_codigo: "17", proveedor_id: 5, proveedor_nombre: "diego", proveedor_codigo: null, mes: 5, destino_nombre: "Actual", pct: 70, importe_calculado: 300 },
    ];
    const originalRows = [{ concepto_codigo: "17", proveedor_id: 5, proveedor_nombre: "Diego", proveedor_codigo: null, mes: 5, importe_original: 1000 }];
    const result = buildComposicionPorProveedor(destinoRows, originalRows);

    expect(result["17|5"][5].destinos).toHaveLength(1);
    expect(result["17|5"][5].destinos[0]).toEqual({ nombre: "Actual", pct: 70, importe: 700 });
    expect(result["17|5"][5].total).toBe(1000);
  });
});

describe("mergeComposiciones", () => {
  it("fusiona dos composiciones con el mismo destino, sumando importe y recalculando pct sobre el total combinado", () => {
    const a = { total: 100, destinos: [{ nombre: "Ramos Mejía — Bar", pct: 70, importe: 70 }] };
    const b = { total: 200, destinos: [{ nombre: "Ramos Mejía — Bar", pct: 100, importe: 200 }] };
    const result = mergeComposiciones([a, b], 0);
    expect(result).toEqual({
      total: 300,
      destinos: [{ nombre: "Ramos Mejía — Bar", pct: 90, importe: 270 }],
    });
  });

  it("agrega bucket 'Sin apertura' con el totalSinRegla que pasa el caller (montos de los hijos sin regla)", () => {
    const a = { total: 110, destinos: [{ nombre: "Ramos Mejía — Bar", pct: 70, importe: 77 }, { nombre: "Ramos Mejía — Canchas", pct: 30, importe: 33 }] };
    const result = mergeComposiciones([a, undefined], 918367);
    expect(result?.total).toBe(918477);
    expect(result?.destinos).toEqual([
      { nombre: "Ramos Mejía — Bar", pct: (77 / 918477) * 100, importe: 77 },
      { nombre: "Ramos Mejía — Canchas", pct: (33 / 918477) * 100, importe: 33 },
      { nombre: "Sin apertura", pct: (918367 / 918477) * 100, importe: 918367 },
    ]);
  });

  it("no depende del filtro de PDV activo: el total con regla es siempre el reparto completo, no el valor filtrado de la celda", () => {
    // Caso real: proveedor.values[mes] filtrado a un PDV puede ser MENOR que
    // la suma de composicion.total de sus conceptos (que es siempre el
    // reparto completo, sin filtrar — spec de app/api/dashboard/pivot/route.ts
    // §"La composición del tooltip SIEMPRE muestra el reparto completo").
    // mergeComposiciones no debe comparar contra ese valor filtrado.
    const bar = { total: 2695000, destinos: [{ nombre: "Ramos Mejía — Bar", pct: 100, importe: 2695000 }] };
    const canchas = { total: 1155000, destinos: [{ nombre: "Ramos Mejía — Canchas", pct: 100, importe: 1155000 }] };
    const result = mergeComposiciones([bar, canchas], 0);
    expect(result?.total).toBe(3850000);
    expect(result?.destinos.every((d) => d.pct <= 100)).toBe(true);
  });

  it("no agrega bucket 'Sin apertura' cuando totalSinRegla está por debajo del epsilon de redondeo", () => {
    const a = { total: 99.999, destinos: [{ nombre: "X", pct: 100, importe: 99.999 }] };
    const result = mergeComposiciones([a], 0.001);
    expect(result?.destinos).toEqual([{ nombre: "X", pct: expect.closeTo(99.999, 2), importe: 99.999 }]);
  });

  it("devuelve undefined si ninguna parte tiene composicion", () => {
    const result = mergeComposiciones([undefined, undefined], 500);
    expect(result).toBeUndefined();
  });

  it("no genera bucket negativo cuando totalSinRegla llega negativo por redondeo flotante (no debería pasar en uso real, pero no debe romper)", () => {
    const a = { total: 100, destinos: [{ nombre: "X", pct: 100, importe: 100 }] };
    const result = mergeComposiciones([a], -0.001);
    expect(result?.destinos.find((d) => d.nombre === "Sin apertura")).toBeUndefined();
  });
});
