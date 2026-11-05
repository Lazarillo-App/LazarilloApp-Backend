// Portado de lazarillo_gestion/lib/arca/csv.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { leerCsvArca, tipoModal, esNotaCredito } = require('./csv');

const CAB = '"Fecha de Emisión";"Tipo de Comprobante";"Punto de Venta";"Número Desde";"Número Hasta";"Cód. Autorización";"Tipo Doc. Emisor";"Nro. Doc. Emisor";"Denominación Emisor";"Tipo Doc. Receptor";"Nro. Doc. Receptor";"Tipo Cambio";"Moneda";"Imp. Neto Gravado IVA 0%";"IVA 2,5%";"Imp. Neto Gravado IVA 2,5%";"IVA 5%";"Imp. Neto Gravado IVA 5%";"IVA 10,5%";"Imp. Neto Gravado IVA 10,5%";"IVA 21%";"Imp. Neto Gravado IVA 21%";"IVA 27%";"Imp. Neto Gravado IVA 27%";"Imp. Neto Gravado Total";"Imp. Neto No Gravado";"Imp. Op. Exentas";"Otros Tributos";"Total IVA";"Imp. Total"';
const F1 = "2025-01-01;1;6;33230;33230;74524564289692;80;30658180424;ACTO SA;80;30715707345;1,00;$;;;;;;6397,97;60933,03;;;;;60933,03;0,00;0,00;0,00;6397,97;67331,00";
const F2 = "2025-01-01;3;5;2959;2959;75016207821782;80;30717142116;RTP GROUP S.A.S.;80;30715707345;1,00;$;;;;;;;;25591,08;121862,29;;;121862,29;0,00;0,00;1.234,50;25591,08;148687,87";

describe("CSV de ARCA", () => {
  it("lee las filas reales", () => {
    const r = leerCsvArca(`﻿${CAB}\r\n${F1}\r\n${F2}\r\n`);
    expect(r.errores).toEqual([]);
    expect(r.comprobantes).toHaveLength(2);
    expect(r.comprobantes[0]).toMatchObject({ cuitEmisor: "30658180424", cuitReceptor: "30715707345", tipo: 1, puntoVenta: 6, numero: 33230, fecha: "2025-01-01", total: 67331, iva: 6397.97, neto: 60933.03, emisor: "ACTO SA" });
    expect(r.comprobantes[1].otrosTributos).toBe(1234.5);
  });
  it("rechaza otro archivo", () => {
    expect(leerCsvArca("a;b;c\n1;2;3").errores[0]).toMatch(/Mis Comprobantes/);
  });
  it("tipos", () => {
    expect(tipoModal(11)).toBe("FcC"); expect(tipoModal(3)).toBe("NC-A"); expect(esNotaCredito(8)).toBe(true); expect(esNotaCredito(1)).toBe(false);
  });
});
