// Tests de services/servicioCosto.js con una base falsa (sin Postgres).
'use strict';

const { describe, expect, it } = require('./gestion/test-utils/vitest');
const srv = require('./servicioCosto');

// Base falsa: ancla 10 (precio 100) + derivado 11 (factor 0,5). Local factura 2.000/mes, el servicio 1.000.
function dbFalsa(base = null) {
  return {
    query: async (sql) => {
      if (sql.includes("'derivado'")) return { rows: [{ article_id: 11, nombre: 'Media', factor: 0.5 }] };
      if (sql.includes('FROM recetas')) return { rows: [{ id: 1, article_id: 10, nombre: 'Hora', porciones: 1,
        servicio: { tipo: 'ancla', sucursal: null, reparto: 'ventas', propios: ['P'], base } }] };
      if (sql.includes('app_businesses')) return { rows: [{ organization_id: 1 }] };
      if (sql.includes('sales_daily_items')) {
        return { rows: srv.mesesCerrados(12, new Date('2026-11-20')).map((m) => (
          { m, total: 2000, familia: 1000, ancla_monto: 500, ancla_qty: 5 })) };
      }
      if (sql.includes('gestion_v_compras_distribuidas')) {
        return { rows: [
          { r: '21', codigo: 'A', nombre: 'Alquiler', total: 3000 },   // 1.000 / mes
          { r: '2', codigo: 'P', nombre: 'Propio', total: 300 },       // 100 / mes, 100 % del servicio
          { r: '1', codigo: 'M', nombre: 'Mercaderías', total: 9000 }, // no entra por defecto
        ] };
      }
      throw new Error('consulta no esperada');
    },
  };
}

describe('mesesCerrados', () => {
  it('termina en el mes pasado y cruza el año', () => {
    expect(srv.mesesCerrados(3, new Date('2026-01-10'))).toEqual(['2025-10', '2025-11', '2025-12']);
  });
});

describe('normalizarConfig', () => {
  it('derivado sin factor no vale', () => {
    expect(srv.normalizarConfig({ tipo: 'derivado', ancla: 5 })).toBe(null);
  });
  it('ancla: mercaderías afuera por defecto', () => {
    expect(srv.normalizarConfig({ tipo: 'ancla' }).incluir.mercaderias).toBe(false);
  });
});

describe('calcularAncla', () => {
  it('horas del promedio anual, reparto por ventas y propios al 100 %', async () => {
    const c = await srv.calcularAncla(1, 10, { db: dbFalsa(), hoy: new Date('2026-11-20') });
    expect(c.horas).toBe(10);                       // 1.000 / 100 cada mes
    expect(c.parteVentas).toBe(0.5);                // 1.000 / 2.000
    expect(c.costoMes).toBe(1000 * 0.5 + 100);      // alquiler a la mitad + propio entero
    expect(c.costoHora).toBe(60);
    expect(c.familia.find((f) => f.articleId === 11).costo).toBe(30);
  });
});

describe('vsBase', () => {
  it('la hora sube lo mismo que los costos desde el último aumento', async () => {
    // Base: costo del mes 500 con la hora a 100. Hoy el costo del mes es 600 → +20 % → hora a 120.
    const base = { fecha: '2026-12-01', costoMes: 500, costoHora: 50, precio: 100 };
    const c = await srv.calcularAncla(1, 10, { db: dbFalsa(base), hoy: new Date('2026-11-20') });
    expect(Math.round(c.vsBase.suba * 1000) / 1000).toBe(0.2);
    expect(Math.round(c.vsBase.precioSugerido)).toBe(120);
    expect(c.precioActual).toBe(100);
    expect(Math.round(c.margen * 100)).toBe(40);       // 1 − 60/100
    expect(c.vsBase.margenBajo).toBe(true);            // 40 % < 50 % − 5
  });
  it('una base mal formada no cuenta', () => {
    expect(srv.normalizarBase({ fecha: 'ayer', costoMes: 5 })).toBe(null);
  });
});
