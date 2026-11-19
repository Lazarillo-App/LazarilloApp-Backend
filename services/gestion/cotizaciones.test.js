// Cotizaciones del dólar (Diego 19/11/2026): lee de la tabla y, si falta, trae de las fuentes públicas.
'use strict';

const Module = require('module');
const origLoad = Module._load;
let tabla = [];
let insertados = 0;
Module._load = function (req, parent, ...r) {
  if (req === './db') {
    const sql = (strings, ...vals) => ({ strings, vals }); sql.raw = sql; sql.join = sql;
    return {
      sql,
      db: {
        execute: async (q) => { const [tipos, fechas, , ventas] = q.vals; tipos.forEach((t, i) => tabla.push({ tipo: t, fecha: fechas[i], venta: ventas[i] })); insertados += tipos.length; },
        one: async (q) => {
          const [tipo, fecha] = q.vals;
          const ok = tabla.filter((x) => x.tipo === tipo && x.fecha <= fecha).sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
          return ok[0] ? { fecha: ok[0].fecha, venta: ok[0].venta, compra: null } : null;
        },
      },
    };
  }
  return origLoad.call(this, req, parent, ...r);
};
const { describe, it, expect } = require('./test-utils/vitest');
const { obtenerCotizacion } = require('./cotizaciones');
Module._load = origLoad;

const sp = (o) => new URLSearchParams(o);
let pedidos = [];
global.fetch = async (url) => {
  pedidos.push(url);
  if (url.includes('dolarapi')) return { ok: true, json: async () => ({ compra: 1440, venta: 1460 }) };
  return { ok: true, json: async () => [{ fecha: '2026-11-13', compra: 1400, venta: 1420 }, { fecha: '2026-11-14', compra: 1410, venta: 1430 }] };
};

describe('obtenerCotizacion', () => {
  it('una fecha pasada sin datos trae la historia y usa el último hábil (sábado → viernes)', async () => {
    tabla = []; pedidos = [];
    const c = await obtenerCotizacion({ sp: sp({ tipo: 'blue', fecha: '2026-11-15' }) });
    expect(c.disponible).toBe(true);
    expect(c.fecha).toBe('2026-11-14');
    expect(c.venta).toBe(1430);
    expect(pedidos.length).toBe(1);
    // La segunda vez sale de la tabla, sin pedir nada.
    await obtenerCotizacion({ sp: sp({ tipo: 'blue', fecha: '2026-11-15' }) });
    expect(pedidos.length).toBe(1);
  });

  it('MEP pide la casa «bolsa»; tipo inválido da 400', async () => {
    tabla = []; pedidos = [];
    await obtenerCotizacion({ sp: sp({ tipo: 'mep', fecha: '2026-11-14' }) });
    expect(pedidos[0]).toContain('/bolsa');
    let err = null;
    try { await obtenerCotizacion({ sp: sp({ tipo: 'cripto' }) }); } catch (e) { err = e; }
    expect(err.status).toBe(400);
  });

  it('si la fuente no responde, no sugiere nada (se carga a mano)', async () => {
    tabla = []; pedidos = [];
    const f = global.fetch;
    global.fetch = async () => { throw new Error('sin red'); };
    const c = await obtenerCotizacion({ sp: sp({ tipo: 'blue', fecha: '2026-11-10' }) });
    expect(c.disponible).toBe(false);
    global.fetch = f;
  });
});
