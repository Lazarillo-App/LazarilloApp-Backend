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

// toMatchObject: el objeto real contiene (recursivamente) lo esperado.
function contiene(real, esperado) {
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
    toEqual: (esp) => {
      let ok = true;
      try { assert.deepStrictEqual(sinUndefined(real), sinUndefined(esp)); } catch { ok = false; }
      chequear(ok, `${inspeccionar(real)} toEqual ${inspeccionar(esp)}`);
    },
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

// vitest#toEqual ignora propiedades con valor undefined; deepStrictEqual no.
function sinUndefined(v) {
  if (Array.isArray(v)) return v.map(sinUndefined);
  if (v && typeof v === 'object' && !(v instanceof Date) && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = sinUndefined(x);
    return out;
  }
  return v;
}

function inspeccionar(v) {
  try { return require('node:util').inspect(v, { depth: 4 }); } catch { return String(v); }
}

function expect(real) {
  const base = matchers(real, false);
  base.not = matchers(real, true);
  return base;
}

module.exports = { describe, it, expect, beforeEach, afterEach };
