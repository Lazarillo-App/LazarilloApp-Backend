// services/kit/cargas.js
// Lo que sube el kit vinculado (sin Drive ni clave de la base en la PC). Escribe EXACTAMENTE
// como lz_render.py escribía directo en Postgres, así Balance, Recetas y RRHH no cambian nada:
//   - informe (i22_..._2026, i000_nomina, ...): columnas pdv (+ fila 1..n en el orden del
//     informe) + las del informe; cada carga reemplaza las filas de ESE pdv (DELETE WHERE pdv).
//   - maestro (m6_..., m0_..., m17_..., m00_...): una sola tabla por esquema; cada carga la
//     reemplaza entera. Solo lo puede subir la PC que arma los maestros.
//   - _cargas (pdv, tabla, filas, detalle, pc, cargado) del esquema, igual que hoy.
// El esquema y el pdv salen SIEMPRE de la PC (kit_pcs), nunca de lo que manda el kit. Los nombres
// de tabla/columna y los tipos se validan contra una lista cerrada antes de armar cualquier SQL.
'use strict';

const pool = require('../../config/db');

const TIPOS = new Set(['text', 'bigint', 'integer', 'smallint', 'numeric', 'double precision', 'real',
  'boolean', 'date', 'timestamp', 'timestamp without time zone', 'timestamptz', 'timestamp with time zone']);
const RE_TABLA = /^[im][0-9]{1,3}[a-z0-9_]{0,58}$/;
const RE_COL = /^[a-z_][a-z0-9_]{0,62}$/;
const MAX_FILAS = 250_000;
const COL_PDV = 'pdv';
const COL_FILA = 'fila';
const PDV_MAESTROS = '(maestros)';

const q = (id) => `"${id}"`;

function errorDatos(msg) {
  return Object.assign(new Error(msg), { status: 400 });
}

// cuerpo: { tabla, tipo: 'informe'|'maestro', columnas: [{nombre, tipo}], filas: [[...]],
//           numerar?: bool (informes; default true), detalle?: text }
function validar(cuerpo) {
  const { tabla, tipo, columnas, filas } = cuerpo || {};
  if (!RE_TABLA.test(String(tabla || ''))) throw errorDatos('tabla_invalida');
  if (tipo !== 'informe' && tipo !== 'maestro') throw errorDatos('tipo_invalido');
  if ((tipo === 'maestro') !== tabla.startsWith('m')) throw errorDatos('tipo_no_coincide_con_tabla');
  if (!Array.isArray(columnas) || !columnas.length || columnas.length > 400) throw errorDatos('columnas_invalidas');
  const vistas = new Set();
  const cols = columnas.map((c) => {
    const nombre = String(c?.nombre || '');
    let t = String(c?.tipo || 'text').toLowerCase().trim();
    if (!RE_COL.test(nombre)) throw errorDatos(`columna_invalida:${nombre.slice(0, 40)}`);
    if (!TIPOS.has(t)) throw errorDatos(`tipo_de_columna_invalido:${nombre}`);
    if (nombre === COL_PDV) throw errorDatos('columna_reservada:pdv');
    if (vistas.has(nombre)) throw errorDatos(`columna_repetida:${nombre}`);
    vistas.add(nombre);
    return { nombre, tipo: t };
  });
  if (!Array.isArray(filas) || filas.length > MAX_FILAS) throw errorDatos('filas_invalidas');
  for (const f of filas) {
    if (!Array.isArray(f) || f.length !== cols.length) throw errorDatos('fila_con_otro_largo');
  }
  const numerar = tipo === 'informe' && cuerpo.numerar !== false && !vistas.has(COL_FILA);
  return { tabla, tipo, cols, filas, numerar, detalle: String(cuerpo.detalle || '').slice(0, 500) };
}

// Postgres no acepta el caracter nulo en un texto; el resto se guarda tal cual.
function valor(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') { const t = v.replace(/\u0000/g, ''); return t === '' ? null : t; }
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

async function columnasDe(client, esq, tabla) {
  const { rows } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [esq, tabla]);
  return new Map(rows.map((r) => [r.column_name, r.data_type]));
}

// DDL corto (crear esquema/tabla, agregar columnas que falten) en su propia transacción, como
// preparar() de lz_render: así la carga no toma locks largos sobre la tabla.
async function preparar(esq, tabla, defs) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7330000, hashtext($1))', [`${esq}.${tabla}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${q(esq)}`);
    const tiene = await columnasDe(client, esq, tabla);
    if (!tiene.size) {
      await client.query(`CREATE TABLE IF NOT EXISTS ${q(esq)}.${q(tabla)} (${defs.map((d) => `${q(d.nombre)} ${d.tipo}`).join(', ')})`);
    } else {
      for (const d of defs) {
        if (!tiene.has(d.nombre)) await client.query(`ALTER TABLE ${q(esq)}.${q(tabla)} ADD COLUMN IF NOT EXISTS ${q(d.nombre)} ${d.tipo}`);
      }
    }
    await client.query(`CREATE TABLE IF NOT EXISTS ${q(esq)}."_cargas" (pdv text, tabla text, filas bigint, detalle text, pc text, cargado timestamptz)`);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** pc = fila de kit_pcs. Devuelve { tabla, filas }. */
async function cargar(pc, cuerpo) {
  const c = validar(cuerpo);
  const esq = pc.esquema;
  if (!RE_COL.test(esq)) throw Object.assign(new Error('esquema_invalido'), { status: 500 });
  if (c.tipo === 'maestro' && !pc.maestros) {
    throw Object.assign(new Error('esta_pc_no_arma_maestros'), { status: 403 });
  }
  const fijos = c.tipo === 'informe' ? [{ nombre: COL_PDV, tipo: 'text' }] : [];
  const numeradas = c.numerar ? [{ nombre: COL_FILA, tipo: 'integer' }] : [];
  const defs = [...fijos, ...numeradas, ...c.cols];
  await preparar(esq, c.tabla, defs);

  const nombres = defs.map((d) => d.nombre);
  const porSentencia = Math.max(1, Math.floor(30000 / nombres.length));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '600s'");
    await client.query('SELECT pg_advisory_xact_lock(7330000, hashtext($1))', [`${esq}.${c.tabla}`]);
    if (c.tipo === 'informe') {
      await client.query(`DELETE FROM ${q(esq)}.${q(c.tabla)} WHERE ${q(COL_PDV)} = $1`, [pc.pdv]);
    } else {
      await client.query(`DELETE FROM ${q(esq)}.${q(c.tabla)}`);
    }
    const colsSql = nombres.map(q).join(', ');
    for (let i = 0; i < c.filas.length; i += porSentencia) {
      const lote = c.filas.slice(i, i + porSentencia);
      const params = [];
      const tuplas = lote.map((f, k) => {
        const vals = [];
        if (fijos.length) vals.push(pc.pdv);
        if (numeradas.length) vals.push(i + k + 1);
        for (const v of f) vals.push(valor(v));
        return `(${vals.map((v) => { params.push(v); return `$${params.length}`; }).join(', ')})`;
      });
      await client.query(`INSERT INTO ${q(esq)}.${q(c.tabla)} (${colsSql}) VALUES ${tuplas.join(', ')}`, params);
    }
    const pdvCarga = c.tipo === 'informe' ? pc.pdv : PDV_MAESTROS;
    await client.query(`DELETE FROM ${q(esq)}."_cargas" WHERE pdv = $1 AND tabla = $2`, [pdvCarga, c.tabla]);
    await client.query(`INSERT INTO ${q(esq)}."_cargas" VALUES ($1, $2, $3, $4, $5, now())`,
      [pdvCarga, c.tabla, c.filas.length, c.detalle, pc.pc_nombre]);
    await client.query(
      `UPDATE kit_pcs SET ultima_carga = now(), ultimo_contacto = now(), ultima_carga_detalle = $2 WHERE id = $1`,
      [pc.id, `${c.tabla} ${c.filas.length}`]);
    await client.query('COMMIT');
    return { tabla: c.tabla, filas: c.filas.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code && /^22|^23/.test(e.code)) throw Object.assign(new Error(`dato_rechazado: ${e.message}`), { status: 422 });
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { cargar, validar, TIPOS };
