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

// Nombre de cada sucursal para el pulso: la principal (branchId null) con el nombre de su
// sucursal is_main (o el del negocio); las secundarias, el suyo.
async function nombresSucursales(businessId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.name, COALESCE((b.props->>'is_main')::boolean, false) AS is_main, n.name AS negocio
       FROM app_businesses n LEFT JOIN app_branches b ON b.business_id = n.id
      WHERE n.id = $1`, [businessId]);
  const m = new Map();
  for (const r of rows) {
    if (r.id != null && !r.is_main) m.set(Number(r.id), r.name);
    if (r.is_main) m.set(null, r.name);
    if (!m.has(null) && r.negocio) m.set('negocio', r.negocio);
  }
  if (!m.has(null)) m.set(null, m.get('negocio') || null);
  return m;
}

// { subida, ventas, compras, sucursales: [{ pdv, branchId, nombre, subida, ventas, compras }] }
// o null si el negocio no sube por el kit. Diego, 10/11/2026: "¿no debería cada sucursal tener
// su propio pulso?" — cada PC (pdv) se juzga sola; los campos de arriba (la subida MÁS NUEVA)
// quedan por compatibilidad, pero esconden una PC caída si la otra sube: el front usa sucursales.
async function frescuraKit(businessId) {
  const id = Number(businessId);
  const c = cache.get(id);
  if (c && Date.now() - c.t < CACHE_MS) return c.v;
  await refrescarPdvMap();
  const destinos = pdvsDeNegocio(id).filter((p) => RE_NOMBRE.test(p.schema));
  if (!destinos.length) { cache.set(id, { t: Date.now(), v: null }); return null; }
  let nombres = new Map();
  try { nombres = await nombresSucursales(id); } catch (e) { console.warn('[pulso] nombres', e.message); }
  const conCargas = new Map();
  const sucursales = [];
  for (const { pdv, schema, branchId } of destinos) {
    if (!conCargas.has(schema)) conCargas.set(schema, await existe(schema, '_cargas'));
    let subida = null; let subidaRecetas = null;
    if (conCargas.get(schema)) {
      // subidaRecetas: la última subida de lo que lee Recetas (12, 25 y 80), para avisar si Recetas
      // no la leyó todavía (Diego, 11/11: el aviso por lo que pasó, no por fechas de compras).
      const { rows } = await pool.query(
        `SELECT MAX(cargado) AS s,
                MAX(cargado) FILTER (WHERE tabla LIKE 'i12\\_%' OR tabla LIKE 'i25\\_%' OR tabla LIKE 'i80\\_%') AS r
           FROM "${schema}"._cargas WHERE pdv = $1`, [pdv]);
      subida = rows[0]?.s ? new Date(rows[0].s).toISOString() : null;
      subidaRecetas = rows[0]?.r ? new Date(rows[0].r).toISOString() : null;
    }
    sucursales.push({
      pdv,
      branchId: branchId ?? null,
      nombre: nombres.get(branchId ?? null) || pdv,
      subida,
      subidaRecetas,
      ventas: await ultimaFecha(schema, 'i12', [pdv]),
      compras: await ultimaFecha(schema, 'i25', [pdv]),
    });
  }
  const max = (k) => sucursales.reduce((a, x) => (x[k] && (!a || x[k] > a) ? x[k] : a), null);
  const v = { subida: max('subida'), ventas: max('ventas'), compras: max('compras'), sucursales };
  cache.set(id, { t: Date.now(), v });
  return v;
}

// Al tocar "actualizar" o al subir algo nuevo conviene no esperar los 5 minutos.
const olvidarFrescura = (businessId) => cache.delete(Number(businessId));

module.exports = { frescuraKit, olvidarFrescura };
