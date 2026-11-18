// Facturas que se repiten (Diego 18/11/2026): meses sugeridos y correcciones del usuario.
'use strict';

const Module = require('module');
const origLoad = Module._load;
let respuestas = [];
Module._load = function (req, parent, ...r) {
  if (req === '../db') {
    const sql = () => ({}); sql.raw = sql; sql.join = sql;
    return { sql, db: { many: async () => respuestas.shift() ?? [], one: async () => (respuestas.shift() ?? [])[0] } };
  }
  return origLoad.call(this, req, parent, ...r);
};
const { describe, it, expect } = require('../test-utils/vitest');
const { clientesRecurrentes, mesAtras } = require('./recurrentes');
Module._load = origLoad;

// FC Principal al 15/11/2026 (datos reales de la base).
const FILAS = [
  { cliente: 'escuelita de futbolgol', nombre: 'Escuelita de FutbolGOL', n: 10, desde: '2025-12-01', esperado: '2700000', meses_con: [2, 3, 4, 5, 6, 7, 8, 9, 10, 12], primer_mes: '2025-10-01' },
  { cliente: 'luraghi marta alicia', nombre: 'LURAGHI MARTA ALICIA', n: 10, desde: '2025-11-01', esperado: '4426000', meses_con: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12], primer_mes: '2025-10-01' },
];
const correr = (config = [], filas = FILAS, ya = []) => {
  respuestas = [config, filas, ya];
  return clientesRecurrentes({ businessId: 204, sucursal: null, mesActual: '2026-11-01', ultimo: '2026-11-15' });
};

describe('clientesRecurrentes', () => {
  it('sugiere los meses en que facturó el año pasado (colegio sin ene/feb, escuelita sin ene/nov)', async () => {
    const l = await correr();
    const col = l.find((c) => c.cliente === 'luraghi marta alicia');
    const esc = l.find((c) => c.cliente === 'escuelita de futbolgol');
    expect(col.meses).toEqual([false, false, true, true, true, true, true, true, true, true, true, true]);
    expect(esc.meses).toEqual([false, true, true, true, true, true, true, true, true, true, false, true]);
    expect(col.esteMes).toBe(true);
    expect(esc.esteMes).toBe(false);
    expect(l[0].cliente).toBe('luraghi marta alicia'); // de mayor a menor
  });

  it('un mes en que todavía no era cliente se sugiere prendido', async () => {
    const nuevo = [{ cliente: 'club', nombre: 'Club', n: 3, desde: '2026-08-01', esperado: '1000', meses_con: [8, 9, 10], primer_mes: '2026-08-01' }];
    const [c] = await correr([], nuevo);
    expect(c.meses).toEqual([true, true, true, true, true, true, true, true, true, true, true, true]);
  });

  it('lo que corrigió el usuario manda: meses, monto fijo y «ya no es recurrente»', async () => {
    const meses = [false, true, true, true, true, true, true, true, true, true, true, true];
    const l = await correr([
      { cliente: 'escuelita de futbolgol', nombre: 'Escuelita GOL', meses, esperado: '3600000', activo: true },
      { cliente: 'luraghi marta alicia', nombre: null, meses: null, esperado: null, activo: false },
    ]);
    expect(l.length).toBe(1);
    expect(l[0].nombre).toBe('Escuelita GOL');
    expect(l[0].esteMes).toBe(true);
    expect(l[0].esperado).toBe(3600000);
    expect(l[0].esperadoFijo).toBe(true);
    expect(l[0].esperadoAuto).toBe(2700000);
  });

  it('detecta al que saltea algún mes (BigBox: 10 de 12) y no al que factura de vez en cuando', async () => {
    const l = await correr([], [
      { cliente: 'bigbox s.a', nombre: 'BIGBOX S.A', n: 10, desde: '2025-11-01', esperado: '2360000', meses_con: [1, 2, 3, 5, 6, 7, 9, 10, 11, 12], primer_mes: '2025-11-01' },
      { cliente: 'centro cristiano', nombre: 'Centro', n: 3, desde: '2026-06-01', esperado: '900000', meses_con: [6, 7, 9], primer_mes: '2026-06-01' },
    ]);
    expect(l.map((c) => c.cliente)).toEqual(['bigbox s.a']);
    expect(l[0].detectado).toBe(true);
  });

  it('mesAtras cruza el año', () => {
    expect(mesAtras('2026-01-01', 1)).toBe('2025-12-01');
    expect(mesAtras('2026-11-01', 13)).toBe('2025-10-01');
  });
});
