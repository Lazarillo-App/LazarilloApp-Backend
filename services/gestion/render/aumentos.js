// Portado de lazarillo_gestion/lib/render/aumentos.ts (TypeScript → JavaScript, misma lógica).
// Detección de aumentos de precios de la carta desde el informe 12 del kit (Diego 30/10/2026).
// Corre una vez por día, después de la ingesta (services/cron.js). Sin botón: menos es más (Diego 30/10/2026).
// Mira cada agrupación (comidas / bebidas / promos) por separado: a veces sube solo una.
// En gestion el lugar era el PDV; acá es negocio + sucursal (gestion_render_origenes).
'use strict';

const pool = require('../../../config/db');
const { consultaRender, identRender } = require('./db');
const { detectarSemanas, dias, PATRON_BEBIDAS, PATRON_PROMOS } = require('../dashboard/aumentos');

const T12 = 'i12_ventas_por_articulo_ranking_detallado_por_dia_';

/** Ventas por artículo y día de los años pedidos que existan en el kit (UNION de las tablas anuales). */
async function fuente12(esquema, anios) {
  const existen = await consultaRender(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2)',
    [esquema, anios.map((a) => `${T12}${a}`)]);
  if (!existen.length) return null;
  return `(${existen.map((e) => `SELECT codigo, fecha::date AS f, importe, unidades, pdv FROM ${identRender(esquema)}.${identRender(e.t)}`).join(' UNION ALL ')})`;
}

const grupoSql = (rubro) =>
  `CASE WHEN ${rubro} ~* '${PATRON_PROMOS}' THEN 'promos' WHEN ${rubro} ~* '${PATRON_BEBIDAS}' THEN 'bebidas' ELSE 'comidas' END`;

/** Por semana: fracción de artículos (≥5 u.) que subieron más de 3% contra la semana anterior. */
async function subenSemanal(fuente, pdv) {
  const filas = await consultaRender(`
    WITH s AS (SELECT date_trunc('week', f)::date AS w, codigo, SUM(importe) / SUM(unidades) AS pr, SUM(unidades) AS u
               FROM ${fuente} t WHERE pdv = $1 AND unidades > 0 AND importe > 0 GROUP BY 1, 2)
    SELECT a.w::text AS semana, (COUNT(*) FILTER (WHERE a.pr / b.pr > 1.03))::float8 / COUNT(*) AS suben
    FROM s a JOIN s b ON b.codigo = a.codigo AND b.w = a.w - 7
    WHERE a.u >= 5 AND b.u >= 5 AND a.pr / b.pr BETWEEN 0.7 AND 1.6 GROUP BY a.w`, [pdv]);
  return new Map(filas.map((f) => [f.semana, Number(f.suben)]));
}

// Precio de cada artículo en las 2 semanas antes de la fecha vs las semanas 2 y 3 después (la semana del
// aumento queda afuera porque mezcla precios viejos y nuevos), ponderado por lo vendido antes.
const VENTANA = `
  SUM(t.importe) FILTER (WHERE t.f >= x.w - 14 AND t.f < x.w) AS ia, SUM(t.unidades) FILTER (WHERE t.f >= x.w - 14 AND t.f < x.w) AS ua,
  SUM(t.importe) FILTER (WHERE t.f >= x.w + 7 AND t.f < x.w + 21) AS id, SUM(t.unidades) FILTER (WHERE t.f >= x.w + 7 AND t.f < x.w + 21) AS ud`;
const RUBROS = (esquema) =>
  `(SELECT DISTINCT ON (codigo) codigo, rubro FROM ${identRender(esquema)}.${identRender('m6_listado_de_articulos')} ORDER BY codigo)`;

async function ventanas(fuente, esquema, pdv) {
  const filas = await consultaRender(`
    WITH t AS (SELECT codigo, f, importe, unidades FROM ${fuente} t WHERE pdv = $1 AND unidades > 0 AND importe > 0),
    x AS (SELECT DISTINCT date_trunc('week', f)::date AS w FROM t),
    a AS (SELECT x.w, t.codigo, ${VENTANA} FROM x JOIN t ON t.f >= x.w - 14 AND t.f < x.w + 21 GROUP BY 1, 2),
    r AS (SELECT a.w, ${grupoSql('m.rubro')} AS g, ia, (id / ud) / (ia / ua) AS rel
          FROM a LEFT JOIN ${RUBROS(esquema)} m ON m.codigo = a.codigo
          WHERE ua >= 4 AND ud >= 4 AND (id / ud) / (ia / ua) BETWEEN 0.7 AND 1.6)
    SELECT w::text AS semana, g AS grupo, COUNT(*) AS n, (COUNT(*) FILTER (WHERE rel > 1.03))::float8 / COUNT(*) AS suben,
           exp(SUM(ia * ln(rel)) / SUM(ia)) - 1 AS variacion
    FROM r GROUP BY 1, 2`, [pdv]);
  return filas.map((f) => ({ semana: f.semana, grupo: f.grupo, n: Number(f.n), suben: Number(f.suben), variacion: Number(f.variacion) }));
}

/** Cuánto subió la carta en esa fecha, en total y por agrupación. */
async function medirAumento(fuente, esquema, pdv, fecha) {
  const filas = await consultaRender(`
    WITH x AS (SELECT $2::date AS w),
    a AS (SELECT t.codigo, ${VENTANA} FROM x JOIN ${fuente} t ON t.pdv = $1 AND t.unidades > 0 AND t.importe > 0
          AND t.f >= x.w - 14 AND t.f < x.w + 21 GROUP BY 1),
    r AS (SELECT ${grupoSql('m.rubro')} AS g, ia, (id / ud) / (ia / ua) AS rel
          FROM a LEFT JOIN ${RUBROS(esquema)} m ON m.codigo = a.codigo
          WHERE ua >= 4 AND ud >= 4 AND (id / ud) / (ia / ua) BETWEEN 0.7 AND 1.6)
    SELECT COALESCE(g, 'total') AS g, CASE WHEN COUNT(*) >= 5 THEN exp(SUM(ia * ln(rel)) / SUM(ia)) - 1 END AS pct
    FROM r GROUP BY ROLLUP (g)`, [pdv, fecha]);
  const detalle = {};
  let pct = null;
  for (const f of filas) {
    if (f.pct == null) continue;
    if (f.g === 'total') pct = Number(f.pct); else detalle[f.g] = Number(f.pct);
  }
  return { pct, detalle };
}

/** Devuelve, por lugar, las fechas detectadas y las que se anotaron nuevas. */
async function detectarAumentos({ hoy = new Date().toISOString().slice(0, 10) } = {}) {
  const { rows: origenes } = await pool.query(
    'SELECT esquema, pdv, business_id, branch_id FROM gestion_render_origenes WHERE activo ORDER BY id');
  const anio = Number(hoy.slice(0, 4));
  const out = [];
  for (const o of origenes) {
    const lugar = { pdv: o.pdv, businessId: Number(o.business_id), branchId: o.branch_id == null ? null : Number(o.branch_id) };
    const fuente = await fuente12(o.esquema, [anio - 1, anio]);
    if (!fuente) { out.push({ ...lugar, detectados: [], nuevos: [] }); continue; }
    const fechas = detectarSemanas(await ventanas(fuente, o.esquema, o.pdv), await subenSemanal(fuente, o.pdv));
    const nuevos = [];
    for (const f of fechas) {
      const { pct, detalle } = await medirAumento(fuente, o.esquema, o.pdv, f);
      const provisorio = dias(f, hoy) < 21; // todavía no hay 3 semanas después del aumento
      const det = JSON.stringify(detalle);
      const { rows: cerca } = await pool.query(
        `SELECT fecha::text AS fecha, descartado FROM gestion_aumentos_precio
          WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $2 AND ABS(fecha - $3::date) <= 7`,
        [lugar.businessId, lugar.branchId, f]);
      if (cerca.some((c) => c.descartado)) continue; // lo sacaron a mano: no se vuelve a agregar
      if (cerca.length) {
        // Ya estaba (detectado o a mano): se completa/actualiza el %, sin pisar uno cargado a mano.
        await pool.query(
          `UPDATE gestion_aumentos_precio SET pct = $4, detalle = $5::jsonb, provisorio = $6
            WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $2 AND fecha = $3::date AND (origen = 'detectado' OR pct IS NULL)`,
          [lugar.businessId, lugar.branchId, cerca[0].fecha, pct, det, provisorio]);
      } else {
        const r = await pool.query(
          `INSERT INTO gestion_aumentos_precio (business_id, branch_id, fecha, origen, pct, detalle, provisorio)
           VALUES ($1, $2, $3::date, 'detectado', $4, $5::jsonb, $6) ON CONFLICT DO NOTHING`,
          [lugar.businessId, lugar.branchId, f, pct, det, provisorio]);
        if (r.rowCount) nuevos.push(f);
      }
    }
    out.push({ ...lugar, detectados: fechas, nuevos });
  }
  return out;
}

// Una vez por día alcanza (el informe 12 se sube una vez por día). En memoria: si el servicio
// reinicia, vuelve a correr ese día, y no pasa nada porque no duplica.
let ultimoDia = null;
async function detectarAumentosDelDia() {
  const hoy = new Date().toISOString().slice(0, 10);
  if (ultimoDia === hoy) return null;
  ultimoDia = hoy;
  try {
    const r = await detectarAumentos({ hoy });
    const conNuevos = r.filter((x) => x.nuevos.length);
    console.log(`[gestion] aumentos: ${r.length} lugares${conNuevos.length ? `, nuevos ${JSON.stringify(conNuevos)}` : ', sin nuevos'}`);
    return r;
  } catch (e) {
    ultimoDia = null; // que reintente en la próxima hora
    console.error('[gestion] aumentos', e.message);
    return null;
  }
}

module.exports = { detectarAumentos, detectarAumentosDelDia };
