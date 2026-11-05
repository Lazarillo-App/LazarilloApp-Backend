// services/gestion/db.js
//
// Acceso a la base para el código portado de lazarillo_gestion, que estaba
// escrito con Prisma. Dos piezas:
//
// 1) `sql` — equivalente a Prisma.sql / Prisma.join / Prisma.raw: un template
//    tag que arma la consulta con parámetros ($1, $2…) y permite anidar
//    fragmentos. Así los INSERT … ON CONFLICT de gestion quedan idénticos.
//
// 2) `db` — query/one/many/execute sobre el pool del Backend, con los mismos
//    tipos que devolvía Prisma para no cambiar la lógica:
//    - timestamp sin zona → Date en UTC (pg por defecto lo interpreta en la hora
//      LOCAL del servidor: en una PC con UTC-3, una compra del 02/01 00:00 se
//      leería como 01/01 21:00 y cambiaría su rowId). Al escribir, las Date van
//      como ISO en UTC por el mismo motivo.
//    - date → Date a medianoche UTC (como @db.Date de Prisma).
//    - numeric → string (Prisma devolvía Decimal; el código solo usa
//      toString()/Number(), que con string dan lo mismo).
//    Los conversores van por consulta (opción `types` de pg), sin tocar la
//    configuración global que usa el resto del Backend.
'use strict';

const { types } = require('pg');
const pool = require('../../config/db');

// ── sql`…` ────────────────────────────────────────────────────────────────────

class Sql {
  constructor(strings, values) {
    // Aplana fragmentos anidados: sql`a ${sql`b ${x}`} c` → strings/values planos.
    this.strings = [strings[0]];
    this.values = [];
    values.forEach((v, i) => {
      if (v instanceof Sql) {
        this.strings[this.strings.length - 1] += v.strings[0];
        v.values.forEach((vv, j) => {
          this.values.push(vv);
          this.strings.push(v.strings[j + 1]);
        });
        this.strings[this.strings.length - 1] += strings[i + 1];
      } else {
        this.values.push(v);
        this.strings.push(strings[i + 1]);
      }
    });
  }

  // Como Prisma.Sql#sql: el texto con "?" en lugar de los parámetros (lo usan los tests).
  get sql() {
    return this.strings.join('?');
  }

  // { text, values } para pg
  toQuery() {
    let text = this.strings[0];
    for (let i = 0; i < this.values.length; i++) text += `$${i + 1}` + this.strings[i + 1];
    return { text, values: this.values.map(aParametro) };
  }
}

function sql(strings, ...values) {
  return new Sql(strings, values);
}
sql.join = (fragmentos, separador = ', ') => {
  if (!fragmentos.length) throw new Error('sql.join: lista vacía');
  const strings = [''];
  const values = [];
  fragmentos.forEach((f, i) => {
    values.push(f);
    strings.push(i < fragmentos.length - 1 ? separador : '');
  });
  return new Sql(strings, values);
};
sql.raw = (texto) => new Sql([String(texto)], []);
sql.empty = new Sql([''], []);

// Date → ISO UTC. Postgres ignora la zona al guardar en timestamp sin zona, así
// que queda guardada la hora UTC, igual que con Prisma.
function aParametro(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return v;
}

// ── tipos de lectura (iguales a Prisma) ───────────────────────────────────────

const OID = { TIMESTAMP: 1114, TIMESTAMPTZ: 1184, DATE: 1082, NUMERIC: 1700 };
const tiposGestion = {
  getTypeParser(oid, format) {
    if (oid === OID.TIMESTAMP) return (s) => new Date(s.replace(' ', 'T') + 'Z');
    if (oid === OID.DATE) return (s) => new Date(s + 'T00:00:00Z');
    if (oid === OID.NUMERIC) return (s) => s;
    return types.getTypeParser(oid, format);
  },
};

// ── db ────────────────────────────────────────────────────────────────────────

function crearDb(cliente = pool) {
  async function query(consulta, params) {
    const q = consulta instanceof Sql ? consulta.toQuery() : { text: consulta, values: (params || []).map(aParametro) };
    return cliente.query({ ...q, types: tiposGestion });
  }
  return {
    query,
    // El cliente de pg tal cual, para el código del Backend que recibe un client en su transacción.
    cliente,
    // Filas (equivalente a prisma.$queryRaw)
    many: async (consulta, params) => (await query(consulta, params)).rows,
    one: async (consulta, params) => (await query(consulta, params)).rows[0] ?? null,
    // Filas afectadas (equivalente a prisma.$executeRaw)
    execute: async (consulta, params) => (await query(consulta, params)).rowCount,
    // Transacción con un cliente dedicado; fn recibe un db del mismo tipo.
    async transaction(fn) {
      if (cliente !== pool) return fn(this); // ya dentro de una transacción
      const c = await pool.connect();
      // Sin esto, una conexión que se cae mientras está tomada es un error sin atender y tira el proceso.
      // La consulta en curso falla igual y la transacción se reporta como cualquier otro error.
      const alCaer = (err) => console.error('[gestion/db] se cayó la conexión', err.message);
      c.on('error', alCaer);
      try {
        await c.query('BEGIN');
        const r = await fn(crearDb(c));
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch((err) => console.error('[gestion/db] rollback', err));
        throw e;
      } finally {
        c.removeListener('error', alCaer);
        c.release();
      }
    },
  };
}

const db = crearDb();

module.exports = { sql, Sql, db, crearDb };
