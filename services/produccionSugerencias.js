// services/produccionSugerencias.js — cuánto producir según las ventas (usuaria 21/11/2026; la
// planilla vieja mostraba ventas y stock al programar).
// Por cada elaborado: lo que se usó en las últimas 4 semanas = ventas de cada plato que lo lleva ×
// lo que lleva por porción (y, un nivel más, lo que llevan los elaborados que lo usan). Pasado a la
// unidad en que rinde el elaborado y dividido por lo que rinde una tanda → tandas por semana, y por
// día según en qué días se vende. Al lado: lo programado esa semana y lo que falta.
// Las ventas son del negocio (no hay ventas por sucursal); lo programado es de la sucursal.
'use strict';

const pool = require('../config/db');
const { _ctx } = require('./produccion');
const { factorConversion, canonicalUnit } = require('./unidades');

const { contextoDe, exigir, fechaISO, sumarDias, lunesDe } = _ctx;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const SEMANAS = 4;
const PESO = new Set(['gr', 'kg', 'lb']), VOL = new Set(['ml', 'lt', 'oz']);
const familia = (u) => { const c = canonicalUnit(u || 'u'); return PESO.has(c) ? 'peso' : VOL.has(c) ? 'vol' : 'u'; };
const esUnidad = (u) => ['u', 'unidad', 'unidades', 'porcion', 'porciones', 'porc', 'p'].includes(String(u || 'u').toLowerCase().trim());

/** Puro: cantidad de un ingrediente (en su unidad) llevada a la unidad en que rinde el elaborado.
 *  null si no se puede convertir (ej. la receta usa gramos y el elaborado rinde porciones sin peso). */
function aUnidadDeRinde(cant, unidad, elab) {
  const ru = elab.rendimiento_unidad || 'porcion';
  if (esUnidad(ru)) {
    if (esUnidad(unidad)) return cant;
    // Porciones con peso equivalente cargado: 150 g de puré / 300 g por porción = 0,5 porciones.
    const peso = Number(elab.rendimiento_peso);
    if (peso > 0 && elab.unidad_peso && familia(unidad) === familia(elab.unidad_peso)) {
      return (cant * factorConversion(unidad, elab.unidad_peso)) / peso;
    }
    return null;
  }
  if (familia(unidad) !== familia(ru) || esUnidad(unidad)) return null;
  return cant * factorConversion(unidad, ru);
}

/** Puro: redondea las tandas para arriba de a media (como se programa: ½, 1, 1½…). */
const aMedias = (t) => (t > 0 ? Math.ceil(t * 2 - 1e-9) / 2 : 0);

async function sugerencias(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const lunes = lunesDe(fechaISO(req.query.semana) || new Date().toISOString().slice(0, 10));
  const hoyAR = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const hasta = sumarDias(hoyAR, -1), desde = sumarDias(hasta, -(7 * SEMANAS - 1));

  // Elaborados con receta (lo que se puede programar).
  const { rows: elabs } = await pool.query(
    `SELECT r.insumo_id, r.id AS receta_id, COALESCE(i.nombre, r.nombre) AS nombre, ir.nombre AS rubro,
            r.porciones, COALESCE(r.rendimiento_unidad, 'porcion') AS rendimiento_unidad, r.rendimiento_peso, r.unidad_peso
       FROM recetas r LEFT JOIN insumos i ON i.id = r.insumo_id
       LEFT JOIN insumo_rubros ir ON ir.business_id = i.business_id AND ir.codigo::text = i.rubro
      WHERE r.business_id = $1 AND r.insumo_id IS NOT NULL AND r.active = TRUE`, [c.bizId]);
  if (!elabs.length) return { desde, hasta, semana: lunes, items: [] };
  const porInsumo = new Map(elabs.map((e) => [Number(e.insumo_id), e]));
  const ids = [...porInsumo.keys()];

  // Platos (artículos) que llevan cada elaborado, y cuánto por porción vendida.
  const { rows: usos } = await pool.query(
    `SELECT ri.insumo_id, r.article_id, ri.cantidad, ri.unidad, NULLIF(r.porciones, 0) AS porciones
       FROM receta_items ri JOIN recetas r ON r.id = ri.receta_id
      WHERE r.business_id = $1 AND r.active = TRUE AND r.article_id IS NOT NULL AND ri.insumo_id = ANY($2::bigint[]) AND ri.cantidad > 0`,
    [c.bizId, ids]);
  // Elaborados que van dentro de otros elaborados (un nivel).
  const { rows: anidados } = await pool.query(
    `SELECT ri.insumo_id, r.insumo_id AS padre, ri.cantidad, ri.unidad
       FROM receta_items ri JOIN recetas r ON r.id = ri.receta_id
      WHERE r.business_id = $1 AND r.active = TRUE AND r.insumo_id = ANY($2::bigint[]) AND ri.insumo_id = ANY($2::bigint[]) AND ri.cantidad > 0`,
    [c.bizId, ids]);

  // Ventas por artículo y día de la semana (ISO: 1 = lunes … 7 = domingo).
  const arts = [...new Set(usos.map((u) => Number(u.article_id)))];
  const ventas = new Map(); // article_id → { total, dow: [7] }
  if (arts.length) {
    const { rows } = await pool.query(
      `SELECT article_id, EXTRACT(ISODOW FROM day)::int AS dow, SUM(qty)::numeric AS qty
         FROM sales_daily_items WHERE business_id = $1 AND day BETWEEN $2 AND $3 AND article_id = ANY($4::int[])
        GROUP BY 1, 2`, [c.bizId, desde, hasta, arts]);
    for (const r of rows) {
      const k = Number(r.article_id);
      if (!ventas.has(k)) ventas.set(k, { total: 0, dow: [0, 0, 0, 0, 0, 0, 0] });
      const v = ventas.get(k);
      v.total += Number(r.qty) || 0; v.dow[r.dow - 1] += Number(r.qty) || 0;
    }
  }
  const { rows: nombresArt } = arts.length ? await pool.query(
    `SELECT articulo_id AS id, nombre FROM maxi_articles WHERE business_id = $1 AND articulo_id = ANY($2::int[])
     UNION SELECT id, name FROM app_articles WHERE business_id = $1 AND id = ANY($2::int[])`, [c.bizId, arts]) : { rows: [] };
  const nombreArt = new Map(nombresArt.map((r) => [Number(r.id), r.nombre]));

  // Uso directo por elaborado, en su unidad de rinde, por día de la semana (promedio de 4 semanas).
  const uso = new Map(ids.map((id) => [id, { dow: [0, 0, 0, 0, 0, 0, 0], platos: [], sinConversion: false }]));
  for (const u of usos) {
    const e = porInsumo.get(Number(u.insumo_id));
    const v = ventas.get(Number(u.article_id));
    if (!e || !v || !(v.total > 0)) continue;
    const porVenta = aUnidadDeRinde(Number(u.cantidad) / (Number(u.porciones) || 1), u.unidad, e);
    const x = uso.get(Number(u.insumo_id));
    if (porVenta == null) { x.sinConversion = true; continue; }
    for (let d = 0; d < 7; d++) x.dow[d] += (v.dow[d] / SEMANAS) * porVenta;
    x.platos.push({ article_id: Number(u.article_id), nombre: nombreArt.get(Number(u.article_id)) || `#${u.article_id}`, vendidos_semana: Math.round(v.total / SEMANAS) });
  }
  // Un nivel de anidado: si el relleno lleva salsa, la salsa también se necesita.
  for (const a of anidados) {
    const hijo = porInsumo.get(Number(a.insumo_id)), padre = porInsumo.get(Number(a.padre));
    if (!hijo || !padre || Number(a.insumo_id) === Number(a.padre)) continue;
    const rindePadre = Number(padre.porciones);
    if (!(rindePadre > 0)) continue;
    const porUnidadPadre = aUnidadDeRinde(Number(a.cantidad) / rindePadre, a.unidad, hijo);
    if (porUnidadPadre == null) { uso.get(Number(a.insumo_id)).sinConversion = true; continue; }
    const up = uso.get(Number(a.padre)), uh = uso.get(Number(a.insumo_id));
    for (let d = 0; d < 7; d++) uh.dow[d] += up.dow[d] * porUnidadPadre;
    if (up.platos.length) uh.platos.push({ article_id: null, nombre: `dentro de ${padre.nombre}`, vendidos_semana: null });
  }

  // Lo programado esa semana en la sucursal.
  const { rows: prog } = await pool.query(
    `SELECT insumo_id, SUM(tandas)::numeric AS tandas FROM produccion_tareas
      WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $4::bigint AND deleted_at IS NULL AND estado <> 'cancelada'
        AND tipo = 'produccion' AND fecha BETWEEN $2 AND $3 GROUP BY 1`, [c.bizId, lunes, sumarDias(lunes, 6), c.suc]);
  const programado = new Map(prog.map((r) => [Number(r.insumo_id), Number(r.tandas)]));

  const items = [];
  for (const [id, x] of uso) {
    const e = porInsumo.get(id);
    const rinde = Number(e.porciones);
    const semana = x.dow.reduce((s, v) => s + v, 0);
    if (!(semana > 0) && !x.sinConversion) continue;
    const tandas = rinde > 0 ? semana / rinde : null;
    const sugeridas = tandas != null ? aMedias(tandas) : null;
    const prog = programado.get(id) || 0;
    items.push({
      insumo_id: id, nombre: e.nombre, rubro: e.rubro, unidad: e.rendimiento_unidad, rinde_tanda: rinde || null,
      uso_semana: Math.round(semana * 100) / 100,
      uso_dia: x.dow.map((v) => Math.round(v * 100) / 100),
      tandas_dia: rinde > 0 ? x.dow.map((v) => Math.round((v / rinde) * 100) / 100) : null,
      tandas_semana: tandas != null ? Math.round(tandas * 100) / 100 : null,
      sugeridas, programadas: prog, faltan: sugeridas != null ? Math.max(0, aMedias(sugeridas - prog)) : null,
      platos: x.platos.sort((a, b) => (b.vendidos_semana || 0) - (a.vendidos_semana || 0)).slice(0, 6),
      sin_conversion: x.sinConversion,
    });
  }
  items.sort((a, b) => (b.faltan || 0) - (a.faltan || 0) || (b.uso_semana || 0) - (a.uso_semana || 0));
  return { desde, hasta, semana: lunes, semanas: SEMANAS, items };
}

module.exports = { sugerencias, _puros: { aUnidadDeRinde, aMedias } };
