// services/kit/frescuraKit.js
// Para el pulso del header (Diego, 08/11/2026: "dice compras 21/10 atrasado, yo no sé si es que
// está atrasado o que no hay compras cargadas después de esa fecha, ojo con esa falla").
// La fecha del último dato NO dice si los datos están al día: un local puede no tener compras
// cargadas en MaxiRest hace semanas. Lo que sí lo dice:
//   - subida: cuándo subió algo el kit de este negocio por última vez (_cargas del esquema,
//     sirve igual para las PC con Drive y las vinculadas);
//   - ventas / compras: hasta qué fecha llega lo que subió el kit (i12 y i25, lo que lee
//     Recetas), para ver si la app ya tomó todo.
// El esquema y los pdv salen de PDV_MAP (whitelist), nunca del request. Caché de 5 minutos.
'use strict';

const pool = require('../../config/db');
const { pdvsDeNegocio, refrescarPdvMap } = require('../maxiPdvMap');

const RE_NOMBRE = /^[a-z_][a-z0-9_]*$/;
const CACHE_MS = 5 * 60_000;
const cache = new Map();

async function existe(schema, tabla) {
  const { rows } = await pool.query('SELECT to_regclass($1) AS t', [`"${schema}"."${tabla}"`]);
  return !!rows[0]?.t;
}

// Última fecha (YYYY-MM-DD, sin futuras) de las tablas <prefijo>…_<año> del esquema para esos pdv.
async function ultimaFecha(schema, prefijo, pdvs) {
  const anio = new Date().getFullYear();
  for (const y of [anio, anio - 1]) {
    const { rows: tablas } = await pool.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname LIKE $2`,
      [schema, `${prefijo}\\_%\\_${y}`]);
    let max = null;
    for (const { relname } of tablas) {
      if (!RE_NOMBRE.test(relname)) continue;
      const { rows } = await pool.query(
        `SELECT to_char(MAX(fecha)::date, 'YYYY-MM-DD') AS m FROM "${schema}"."${relname}"
          WHERE pdv = ANY($1::text[]) AND fecha <= now() + interval '1 day'`, [pdvs]);
      if (rows[0]?.m && (!max || rows[0].m > max)) max = rows[0].m;
    }
    if (max) return max;
  }
  return null;
}

// { subida: ISO | null, ventas, compras } o null si el negocio no sube por el kit.
async function frescuraKit(businessId) {
  const id = Number(businessId);
  const c = cache.get(id);
  if (c && Date.now() - c.t < CACHE_MS) return c.v;
  await refrescarPdvMap();
  const porEsquema = {};
  for (const p of pdvsDeNegocio(id)) (porEsquema[p.schema] ||= []).push(p.pdv);
  if (!Object.keys(porEsquema).length) { cache.set(id, { t: Date.now(), v: null }); return null; }
  let subida = null, ventas = null, compras = null;
  for (const [schema, pdvs] of Object.entries(porEsquema)) {
    if (!RE_NOMBRE.test(schema)) continue;
    if (await existe(schema, '_cargas')) {
      const { rows } = await pool.query(`SELECT MAX(cargado) AS s FROM "${schema}"._cargas WHERE pdv = ANY($1::text[])`, [pdvs]);
      const s = rows[0]?.s ? new Date(rows[0].s) : null;
      if (s && (!subida || s > subida)) subida = s;
    }
    const v = await ultimaFecha(schema, 'i12', pdvs);
    if (v && (!ventas || v > ventas)) ventas = v;
    const k = await ultimaFecha(schema, 'i25', pdvs);
    if (k && (!compras || k > compras)) compras = k;
  }
  const v = { subida: subida ? subida.toISOString() : null, ventas, compras };
  cache.set(id, { t: Date.now(), v });
  return v;
}

// Al tocar "actualizar" o al subir algo nuevo conviene no esperar los 5 minutos.
const olvidarFrescura = (businessId) => cache.delete(Number(businessId));

module.exports = { frescuraKit, olvidarFrescura };
