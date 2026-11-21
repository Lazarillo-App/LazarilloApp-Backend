// services/produccionRegistros.js — Producción · etapa 2 (usuaria 21/11/2026).
//  · Mise en place: la plantilla de cada plaza (lo que se deja armado al empezar el turno).
//  · Mermas: peso bruto → peso limpio medido en la cocina, contra la merma configurada del insumo.
//  · Desperdicios: lo que se tira y por qué.
//  · Consumos: todo lo que salió de lo comprado sin venderse (producción, mise en place,
//    desperdicios y mermas) por insumo, para el stock (compra + producción − venta − consumos).
// Ver db/migrations/live/163_produccion_etapa2.sql.
'use strict';

const pool = require('../config/db');
const { _ctx } = require('./produccion');
const { factorConversion, canonicalUnit } = require('./unidades');
const { avisarAlEquipoSinEsperar } = require('./notificationService');

const { contextoDe, fallar, exigir, fechaISO, sumarDias, lunesDe, bizInsumos } = _ctx;
const num = (v) => { if (v === '' || v == null) return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const nombreUsuario = `COALESCE(NULLIF(u.display_name, ''), NULLIF(u.name, ''), split_part(u.email, '@', 1))`;
const MOTIVOS = ['Vencido', 'Se pasó de cocción', 'Dañado', 'Se cayó', 'Mal conservado', 'Sobró', 'Otro'];

function rango(req) {
  const desde = fechaISO(req.query.desde) || lunesDe(new Date().toISOString().slice(0, 10));
  const hasta = fechaISO(req.query.hasta) || sumarDias(desde, 6);
  return { desde, hasta };
}
async function insumoValido(c, insumoId) {
  if (!insumoId) return null;
  const { rows } = await pool.query(`SELECT id, nombre, unidad_med FROM insumos WHERE id = $1 AND business_id = $2`, [insumoId, await bizInsumos(c.bizId)]);
  return rows[0] || null;
}

// ── Mise en place ────────────────────────────────────────────────────────────────────────────
async function listarMise(req) {
  const c = await contextoDe(req);
  const { rows } = await pool.query(
    `SELECT m.*, p.nombre AS plaza FROM produccion_mise m JOIN plazas p ON p.id = m.plaza_id AND p.deleted_at IS NULL
      WHERE m.business_id = $1 ORDER BY p.nombre, m.orden, m.id`, [c.bizId]);
  const porPlaza = {};
  for (const r of rows) {
    (porPlaza[r.plaza_id] ||= []).push({ id: Number(r.id), insumo_id: r.insumo_id ? Number(r.insumo_id) : null, nombre: r.nombre, cantidad: num(r.cantidad), unidad: r.unidad });
  }
  return { porPlaza };
}
/** Reemplaza la plantilla entera de la plaza (jefe / dueño / admin). */
async function guardarMise(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const plazaId = Number(req.params.plazaId);
  const { rows: pz } = await pool.query(`SELECT id FROM plazas WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`, [plazaId, c.bizId]);
  if (!pz.length) fallar(404, 'plaza_no_encontrada');
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : null;
  if (!items) fallar(400, 'items_invalidos');
  const limpios = [];
  for (const it of items) {
    const cant = num(it.cantidad);
    const nombre = String(it.nombre || '').trim().slice(0, 120);
    if (!nombre || cant == null || cant <= 0) fallar(400, 'item_invalido', `Revisá «${nombre || 'sin nombre'}»: nombre y cantidad`);
    const ins = await insumoValido(c, Number(it.insumo_id) || null);
    limpios.push({ insumo_id: ins ? Number(ins.id) : null, nombre: ins ? ins.nombre : nombre, cantidad: cant, unidad: String(it.unidad || ins?.unidad_med || '').slice(0, 20) || null });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM produccion_mise WHERE business_id = $1 AND plaza_id = $2`, [c.bizId, plazaId]);
    for (const [i, it] of limpios.entries()) {
      await client.query(
        `INSERT INTO produccion_mise (business_id, plaza_id, insumo_id, nombre, cantidad, unidad, orden, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [c.bizId, plazaId, it.insumo_id, it.nombre, it.cantidad, it.unidad, i, c.uid]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  return { ok: true, items: limpios.length };
}

// ── Mermas ───────────────────────────────────────────────────────────────────────────────────
async function listarMermas(req) {
  const c = await contextoDe(req);
  const { desde, hasta } = rango(req);
  const { rows } = await pool.query(
    `SELECT m.*, ${nombreUsuario} AS usuario,
            (SELECT CASE WHEN im.peso_inicial > 0 THEN (im.peso_inicial - im.peso_final) / im.peso_inicial END
               FROM insumo_mermas im WHERE im.insumo_id = m.insumo_id ORDER BY im.es_default DESC NULLS LAST, im.id LIMIT 1) AS merma_config
       FROM produccion_mermas m LEFT JOIN app_users u ON u.id = m.user_id
      WHERE m.business_id = $1 AND m.deleted_at IS NULL AND m.created_at::date BETWEEN $2 AND $3
        AND ($4::boolean OR m.user_id = $5)
      ORDER BY m.created_at DESC`, [c.bizId, desde, hasta, c.planifica, c.uid]);
  return {
    desde, hasta,
    items: rows.map((r) => {
      const bruto = num(r.bruto), neto = num(r.neto);
      return {
        id: Number(r.id), insumo_id: r.insumo_id ? Number(r.insumo_id) : null, nombre: r.nombre, bruto, neto, unidad: r.unidad, nota: r.nota,
        pct: bruto > 0 ? Math.round(((bruto - neto) / bruto) * 1000) / 10 : null,
        pct_config: r.merma_config != null ? Math.round(Number(r.merma_config) * 1000) / 10 : null,
        usuario: r.usuario, propia: Number(r.user_id) === c.uid, created_at: r.created_at,
      };
    }),
  };
}
async function crearMerma(req) {
  const c = await contextoDe(req);
  const b = req.body || {};
  const bruto = num(b.bruto), neto = num(b.neto);
  if (bruto == null || neto == null || bruto <= 0 || neto < 0) fallar(400, 'pesos_invalidos', 'Cargá el peso bruto y el limpio');
  if (neto > bruto) fallar(400, 'neto_mayor', 'El peso limpio no puede ser mayor que el bruto');
  const ins = await insumoValido(c, Number(b.insumo_id) || null);
  const nombre = ins?.nombre || String(b.nombre || '').trim().slice(0, 120);
  if (!nombre) fallar(400, 'insumo_requerido', 'Elegí el insumo');
  await pool.query(
    `INSERT INTO produccion_mermas (business_id, insumo_id, nombre, bruto, neto, unidad, nota, tarea_id, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [c.bizId, ins ? Number(ins.id) : null, nombre, bruto, neto, String(b.unidad || ins?.unidad_med || 'kg').slice(0, 20),
      String(b.nota || '').trim().slice(0, 300) || null, Number(b.tarea_id) || null, c.uid]);
  return listarMermas(req);
}

// ── Desperdicios ─────────────────────────────────────────────────────────────────────────────
async function listarDesperdicios(req) {
  const c = await contextoDe(req);
  const { desde, hasta } = rango(req);
  const { rows } = await pool.query(
    `SELECT d.*, ${nombreUsuario} AS usuario, p.nombre AS plaza
       FROM produccion_desperdicios d LEFT JOIN app_users u ON u.id = d.user_id LEFT JOIN plazas p ON p.id = d.plaza_id
      WHERE d.business_id = $1 AND d.deleted_at IS NULL AND d.created_at::date BETWEEN $2 AND $3
        AND ($4::boolean OR d.user_id = $5)
      ORDER BY d.created_at DESC`, [c.bizId, desde, hasta, c.planifica, c.uid]);
  return {
    desde, hasta, motivos: MOTIVOS,
    items: rows.map((r) => ({
      id: Number(r.id), tipo: r.tipo, insumo_id: r.insumo_id ? Number(r.insumo_id) : null, nombre: r.nombre, cantidad: num(r.cantidad), unidad: r.unidad,
      motivo: r.motivo, comentario: r.comentario, plaza: r.plaza, usuario: r.usuario, propia: Number(r.user_id) === c.uid, created_at: r.created_at,
    })),
  };
}
async function crearDesperdicio(req) {
  const c = await contextoDe(req);
  const b = req.body || {};
  const cant = num(b.cantidad);
  if (cant == null || cant <= 0) fallar(400, 'cantidad_invalida', 'Cargá la cantidad');
  const motivo = String(b.motivo || '').trim().slice(0, 60);
  if (!motivo) fallar(400, 'motivo_requerido', 'Elegí el motivo');
  const ins = await insumoValido(c, Number(b.insumo_id) || null);
  const nombre = ins?.nombre || String(b.nombre || '').trim().slice(0, 120);
  if (!nombre) fallar(400, 'nombre_requerido', '¿Qué se tiró?');
  const tipo = ['insumo', 'elaborado', 'otro'].includes(b.tipo) ? b.tipo : (ins ? 'insumo' : 'otro');
  await pool.query(
    `INSERT INTO produccion_desperdicios (business_id, tipo, insumo_id, nombre, cantidad, unidad, motivo, comentario, plaza_id, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [c.bizId, tipo, ins ? Number(ins.id) : null, nombre, cant, String(b.unidad || ins?.unidad_med || '').slice(0, 20) || null, motivo,
      String(b.comentario || '').trim().slice(0, 300) || null, Number(b.plaza_id) || null, c.uid]);
  avisarAlEquipoSinEsperar({
    businessId: c.bizId, actorUserId: c.uid, type: 'produccion_nota', title: `Desperdicio: ${nombre} ${cant}${b.unidad ? ` ${b.unidad}` : ''}`,
    message: motivo + (b.comentario ? ` · ${String(b.comentario).slice(0, 120)}` : ''), clave: `desperdicio:${c.bizId}:${c.uid}`, agruparMin: 20,
    metadata: { kind: 'produccion_desperdicio' },
  });
  return listarDesperdicios(req);
}

/** Borrar un registro: el que lo cargó (en el día) o jefe / dueño / admin. */
async function borrarRegistro(req) {
  const c = await contextoDe(req);
  const tabla = req.params.tipo === 'mermas' ? 'produccion_mermas' : req.params.tipo === 'desperdicios' ? 'produccion_desperdicios' : null;
  if (!tabla) fallar(404, 'no_encontrado');
  const { rowCount } = await pool.query(
    `UPDATE ${tabla} SET deleted_at = NOW() WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL
        AND ($3::boolean OR (user_id = $4 AND created_at > NOW() - INTERVAL '24 hours'))`,
    [Number(req.params.id), c.bizId, c.planifica, c.uid]);
  if (!rowCount) fallar(403, 'forbidden', 'Solo lo borra quien lo cargó (en el día) o el jefe');
  return { ok: true };
}

// ── Consumos ─────────────────────────────────────────────────────────────────────────────────
const PESO = new Set(['gr', 'kg', 'lb']), VOL = new Set(['ml', 'lt', 'oz']);
/** Lleva una cantidad a gramos / ml / unidades para poder sumar. */
function aBase(cant, unidad) {
  const u = canonicalUnit(unidad || 'u');
  if (PESO.has(u)) return { cant: cant * factorConversion(u, 'gr'), base: 'gr' };
  if (VOL.has(u)) return { cant: cant * factorConversion(u, 'ml'), base: 'ml' };
  return { cant, base: u };
}
/** Puro: suma por insumo y por origen. */
function sumarConsumos(movs) {
  const m = new Map();
  for (const x of movs) {
    const { cant, base } = aBase(Number(x.cantidad) || 0, x.unidad);
    const k = `${x.insumo_id || `n:${String(x.nombre).toLowerCase()}`}|${base}`;
    if (!m.has(k)) m.set(k, { insumo_id: x.insumo_id || null, nombre: x.nombre, unidad: base, produccion: 0, mise: 0, desperdicio: 0, merma: 0, total: 0 });
    const r = m.get(k);
    r[x.origen] += cant; r.total += cant;
  }
  return [...m.values()].sort((a, b) => b.total - a.total || a.nombre.localeCompare(b.nombre, 'es'));
}

async function consumos(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const { desde, hasta } = rango(req);
  const { rows: usados } = await pool.query(
    `SELECT COALESCE(x.insumo_real_id, x.insumo_id) AS insumo_id, COALESCE(x.nombre_real, x.nombre) AS nombre,
            COALESCE(x.cantidad_real, x.cantidad) AS cantidad, COALESCE(x.unidad_real, x.unidad) AS unidad,
            CASE WHEN t.tipo = 'mise_en_place' THEN 'mise' ELSE 'produccion' END AS origen
       FROM produccion_tarea_insumos x JOIN produccion_tareas t ON t.id = x.tarea_id
      WHERE t.business_id = $1 AND t.deleted_at IS NULL AND t.estado = 'hecha' AND t.fecha BETWEEN $2 AND $3
        AND x.usado AND NOT x.falta AND COALESCE(x.cantidad_real, x.cantidad) > 0`, [c.bizId, desde, hasta]);
  const { rows: desp } = await pool.query(
    `SELECT insumo_id, nombre, cantidad, unidad, 'desperdicio' AS origen FROM produccion_desperdicios
      WHERE business_id = $1 AND deleted_at IS NULL AND created_at::date BETWEEN $2 AND $3`, [c.bizId, desde, hasta]);
  const { rows: mer } = await pool.query(
    `SELECT insumo_id, nombre, bruto - neto AS cantidad, unidad, 'merma' AS origen FROM produccion_mermas
      WHERE business_id = $1 AND deleted_at IS NULL AND created_at::date BETWEEN $2 AND $3 AND bruto > neto`, [c.bizId, desde, hasta]);
  const items = sumarConsumos([...usados, ...desp, ...mer]);
  // Lo producido (entra al stock de elaborados).
  const { rows: prod } = await pool.query(
    `SELECT t.insumo_id, t.titulo, t.unidad, SUM(t.rinde_real) AS rinde, SUM(t.tandas) AS tandas, COUNT(*)::int AS veces
       FROM produccion_tareas t WHERE t.business_id = $1 AND t.deleted_at IS NULL AND t.estado = 'hecha' AND t.tipo = 'produccion'
        AND t.fecha BETWEEN $2 AND $3 GROUP BY 1, 2, 3 ORDER BY 2`, [c.bizId, desde, hasta]);
  // Costo estimado (solo dueño/admin: el staff no ve plata).
  if (c.gestor) {
    const ids = items.map((i) => i.insumo_id).filter(Boolean);
    if (ids.length) {
      const { rows } = await pool.query(`SELECT id, precio_ref, unidad_med FROM insumos WHERE id = ANY($1::bigint[])`, [ids]);
      const p = new Map(rows.map((r) => [Number(r.id), r]));
      for (const i of items) {
        const r = p.get(Number(i.insumo_id));
        if (!r || !(Number(r.precio_ref) > 0)) continue;
        const f = factorConversion(i.unidad, r.unidad_med || i.unidad);
        if (Number.isFinite(f)) i.costo = Math.round(i.total * f * Number(r.precio_ref));
      }
    }
  }
  return {
    desde, hasta, items,
    producido: prod.map((r) => ({ insumo_id: r.insumo_id ? Number(r.insumo_id) : null, titulo: r.titulo, unidad: r.unidad, rinde: num(r.rinde), tandas: num(r.tandas), veces: r.veces })),
  };
}

module.exports = {
  listarMise, guardarMise, listarMermas, crearMerma, listarDesperdicios, crearDesperdicio, borrarRegistro, consumos,
  _puros: { aBase, sumarConsumos },
};
