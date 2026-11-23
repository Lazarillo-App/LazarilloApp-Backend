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
      if (sql.includes('app_branches')) return { rows: [] };
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

// Último aumento detectado en las ventas (Diego 23/11/2026): Cancha 3 de Ramos pasó de $ 70.000 a
// $ 75.000 el 07/09/2026; un día suelto con venta grande (42.727) no corta.
describe('detectarAumento', () => {
  it('encuentra el último aumento y saltea días sueltos', () => {
    const d = (f, p) => ({ fecha: `2026-${f}`, precio: p });
    const dias = [d('08-24', 70000), d('08-25', 70000), d('08-26', 70000), d('08-27', 70000), d('08-28', 42727),
      d('08-29', 70000), d('08-31', 70000), d('09-01', 70000), d('09-02', 70000), d('09-05', 70000),
      d('09-07', 75000), d('09-08', 75000), d('09-09', 60000), d('09-10', 75000), d('09-11', 75000), d('09-12', 75000)];
    expect(srv.detectarAumento(dias)).toEqual({ fecha: '2026-09-07', antes: 70000, despues: 75000 });
    expect(srv.detectarAumento(dias.slice(10))).toBe(null);
  });
});

// Cantidad de horas (Diego 23/11/2026): el colegio son 40 horas al 33 % de la hora de la ancla.
describe('normalizarConfig derivado con horas', () => {
  it('factor = horas × % ÷ 100 y guarda los dos', () => {
    expect(srv.normalizarConfig({ tipo: 'derivado', ancla: 6102, horas: 40, pctHora: 33 }))
      .toEqual({ tipo: 'derivado', ancla: 6102, horas: 40, pctHora: 33, factor: 13.2 });
    expect(srv.normalizarConfig({ tipo: 'derivado', ancla: 6102, factor: 0.93 })).toEqual({ tipo: 'derivado', ancla: 6102, factor: 0.93 });
  });
});

// Por sucursal (Diego 23/11/2026): cada sucursal con sus gastos y ventas; «Todas» suma; el alquiler
// puede salir de otro PDV.
describe('calcularAncla por sucursal', () => {
  const hoy = new Date('2026-11-20');
  const db = { query: async (sql, params) => {
    if (sql.includes('app_branches')) return { rows: [{ id: 16, name: 'RAMOS', principal: true }, { id: 15, name: 'SAN JUSTO', principal: false }] };
    if (sql.includes("'derivado'")) return { rows: [] };
    if (sql.includes('FROM recetas')) return { rows: [{ id: 1, article_id: 10, nombre: 'Hora', porciones: 1,
      servicio: { tipo: 'ancla', reparto: 'manual', pct: { alquiler: 100, sueldos: 100, servicios: 100 }, propios: [], alquilerDe: { 15: 'main' } } }] };
    if (sql.includes('app_businesses')) return { rows: [{ organization_id: 1 }] };
    if (sql.includes('to_char(day, \'YYYY-MM-DD\')')) return { rows: [] };
    if (sql.includes('sales_daily_items')) {
      const sj = sql.includes('branch_id = $4');
      return { rows: srv.mesesCerrados(12, hoy).map((m) => ({ m, total: 1000, familia: 1000, ancla_monto: sj ? 100 : 200, ancla_qty: sj ? 1 : 2 })) };
    }
    if (sql.includes('gestion_v_compras_distribuidas')) {
      return { rows: [
        { b: null, r: '21', codigo: 'A', nombre: 'Alquiler', total: 3000 },  // Ramos: 1.000 / mes
        { b: 15, r: '21', codigo: 'A', nombre: 'Alquiler', total: 300 },     // San Justo: 100 / mes
        { b: 15, r: '3', codigo: 'S', nombre: 'Sueldos', total: 600 },       // San Justo: 200 / mes
      ] };
    }
    throw new Error('consulta no esperada');
  } };
  it('San Justo toma el alquiler de Ramos y sus propios sueldos; Todas suma', async () => {
    const sj = await srv.calcularAncla(1, 10, { db, hoy, sucursal: 15, detectar: false });
    expect(sj.sucursal).toBe('15');
    expect(sj.alquilerDe).toBe('main');
    expect(Math.round(sj.costoMes)).toBe(1200);
    const ramos = await srv.calcularAncla(1, 10, { db, hoy, sucursal: 16, detectar: false });
    expect(ramos.sucursal).toBe('main');
    expect(Math.round(ramos.costoMes)).toBe(1000);
    const todas = await srv.calcularAncla(1, 10, { db, hoy, detectar: false });
    expect(todas.sucursal).toBe('all');
    expect(Math.round(todas.costoMes)).toBe(2200);
    expect(Math.round(todas.horas)).toBe(20);
  });
});
