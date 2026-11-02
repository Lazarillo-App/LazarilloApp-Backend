// services/gestion/test-utils/vitest.js
//
// Los tests de lazarillo_gestion están escritos con vitest. Para portarlos casi
// sin cambios (y sin sumar vitest al Backend), este módulo expone la misma
// interfaz encima del runner que ya trae Node (`node --test`): describe/it y un
// `expect` con los matchers que esos tests usan. Si un test portado usa un
// matcher que acá no está, falla con un error claro en vez de pasar en silencio.
'use strict';

const assert = require('node:assert/strict');
const { describe, it: nodeIt, beforeEach, afterEach } = require('node:test');

function formatear(plantilla, args) {
  let i = 0;
  return plantilla.replace(/%[sdifjo]/g, () => {
    const v = args[i++];
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

function it(nombre, fn) {
  return nodeIt(nombre, fn);
}
it.each = (casos) => (nombre, fn) => {
  for (const caso of casos) {
    const args = Array.isArray(caso) ? caso : [caso];
    nodeIt(formatear(nombre, args), () => fn(...args));
  }
};

// Comparadores "asimétricos" de vitest (expect.closeTo, expect.arrayContaining, expect.any):
// pueden aparecer anidados dentro de lo esperado por toEqual / toMatchObject.
class Asimetrico {
  constructor(descripcion, cumple) { this.descripcion = descripcion; this.cumple = cumple; }
}

// toEqual: igualdad profunda; como vitest, ignora propiedades con valor undefined.
function igual(real, esperado) {
  if (esperado instanceof Asimetrico) return esperado.cumple(real);
  if (esperado instanceof Date) return real instanceof Date && real.getTime() === esperado.getTime();
  if (esperado === null || typeof esperado !== 'object') return Object.is(real, esperado);
  if (real === null || typeof real !== 'object') return false;
  if (Array.isArray(esperado)) {
    return Array.isArray(real) && real.length === esperado.length && esperado.every((e, i) => igual(real[i], e));
  }
  if (Array.isArray(real)) return false;
  if (esperado instanceof Map || esperado instanceof Set) {
    try { assert.deepStrictEqual(real, esperado); return true; } catch { return false; }
  }
  const claves = (o) => Object.keys(o).filter((k) => o[k] !== undefined);
  const kr = claves(real);
  const ke = claves(esperado);
  return kr.length === ke.length && ke.every((k) => igual(real[k], esperado[k]));
}

// toMatchObject: el objeto real contiene (recursivamente) lo esperado.
function contiene(real, esperado) {
  if (esperado instanceof Asimetrico) return esperado.cumple(real);
  if (esperado === null || typeof esperado !== 'object') return Object.is(real, esperado) || (esperado instanceof Date && real instanceof Date && esperado.getTime() === real.getTime());
  if (real === null || typeof real !== 'object') return false;
  if (Array.isArray(esperado)) {
    return Array.isArray(real) && real.length === esperado.length && esperado.every((e, i) => contiene(real[i], e));
  }
  if (esperado instanceof Date) return real instanceof Date && real.getTime() === esperado.getTime();
  return Object.keys(esperado).every((k) => contiene(real[k], esperado[k]));
}

function matchers(real, negado) {
  const chequear = (ok, mensaje) => {
    if (negado ? ok : !ok) assert.fail(negado ? `NO se esperaba: ${mensaje}` : mensaje);
  };
  const m = {
    toBe: (esp) => chequear(Object.is(real, esp), `${inspeccionar(real)} toBe ${inspeccionar(esp)}`),
    toEqual: (esp) => chequear(igual(real, esp), `${inspeccionar(real)} toEqual ${inspeccionar(esp)}`),
    toStrictEqual: (esp) => {
      let ok = true;
      try { assert.deepStrictEqual(real, esp); } catch { ok = false; }
      chequear(ok, `${inspeccionar(real)} toStrictEqual ${inspeccionar(esp)}`);
    },
    toBeCloseTo: (n, digitos = 2) => chequear(Math.abs(real - n) < 10 ** -digitos / 2, `${real} toBeCloseTo ${n}`),
    toContain: (x) => chequear(real != null && (typeof real === 'string' ? real.includes(x) : [...real].some((v) => Object.is(v, x))), `${inspeccionar(real)} toContain ${inspeccionar(x)}`),
    toBeGreaterThan: (n) => chequear(real > n, `${real} toBeGreaterThan ${n}`),
    toBeGreaterThanOrEqual: (n) => chequear(real >= n, `${real} toBeGreaterThanOrEqual ${n}`),
    toBeLessThan: (n) => chequear(real < n, `${real} toBeLessThan ${n}`),
    toBeLessThanOrEqual: (n) => chequear(real <= n, `${real} toBeLessThanOrEqual ${n}`),
    toBeNull: () => chequear(real === null, `${inspeccionar(real)} toBeNull`),
    toBeUndefined: () => chequear(real === undefined, `${inspeccionar(real)} toBeUndefined`),
    toBeInstanceOf: (clase) => chequear(real instanceof clase, `${inspeccionar(real)} toBeInstanceOf ${clase.name}`),
    toHaveLength: (n) => chequear(real != null && real.length === n, `largo ${real?.length} toHaveLength ${n}`),
    toMatch: (patron) => chequear(typeof patron === 'string' ? String(real).includes(patron) : patron.test(String(real)), `${inspeccionar(real)} toMatch ${patron}`),
    toMatchObject: (esp) => chequear(contiene(real, esp), `${inspeccionar(real)} toMatchObject ${inspeccionar(esp)}`),
  };
  return new Proxy(m, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      throw new Error(`test-utils/vitest: matcher "${String(prop)}" no implementado — agregarlo antes de portar este test`);
    },
  });
}

function inspeccionar(v) {
  if (v instanceof Asimetrico) return v.descripcion;
  try { return require('node:util').inspect(v, { depth: 4 }); } catch { return String(v); }
}

function expect(real) {
  const base = matchers(real, false);
  base.not = matchers(real, true);
  return base;
}
expect.arrayContaining = (items) =>
  new Asimetrico(`arrayContaining(${inspeccionar(items)})`, (r) => Array.isArray(r) && items.every((e) => r.some((x) => igual(x, e))));
expect.closeTo = (n, digitos = 2) =>
  new Asimetrico(`closeTo(${n}, ${digitos})`, (r) => typeof r === 'number' && Math.abs(r - n) < 10 ** -digitos / 2);
expect.any = (clase) =>
  new Asimetrico(`any(${clase.name})`, (r) => r != null && (r.constructor === clase || r instanceof clase));

module.exports = { describe, it, expect, beforeEach, afterEach };
