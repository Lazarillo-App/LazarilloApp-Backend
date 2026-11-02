'use strict';

const { describe, it, expect } = require('./test-utils/vitest');
const { sql } = require('./db');

describe('sql (equivalente a Prisma.sql)', () => {
  it('numera los parámetros', () => {
    const q = sql`SELECT * FROM t WHERE a = ${1} AND b = ${'x'}`.toQuery();
    expect(q.text).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(q.values).toEqual([1, 'x']);
  });

  it('aplana fragmentos anidados y join (como Prisma.join)', () => {
    const filas = [[1, 'a'], [2, 'b']].map(([n, s]) => sql`(${n}, ${s}::text)`);
    const q = sql`INSERT INTO t VALUES ${sql.join(filas)} ON CONFLICT DO NOTHING`.toQuery();
    expect(q.text).toBe('INSERT INTO t VALUES ($1, $2::text), ($3, $4::text) ON CONFLICT DO NOTHING');
    expect(q.values).toEqual([1, 'a', 2, 'b']);
  });

  it('raw y empty no agregan parámetros', () => {
    const q = sql`SELECT ${sql.raw('"rowId"')} FROM t ${sql.empty}WHERE x = ${5}`.toQuery();
    expect(q.text).toBe('SELECT "rowId" FROM t WHERE x = $1');
    expect(q.values).toEqual([5]);
  });

  it('las fechas van como ISO UTC (no en la hora local del servidor)', () => {
    const q = sql`SELECT ${new Date('2026-01-02')}`.toQuery();
    expect(q.values).toEqual(['2026-01-02T00:00:00.000Z']);
  });
});
