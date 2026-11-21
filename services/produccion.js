// services/produccion.js — Tareas operativas · producción de elaborados (usuaria 21/11/2026).
// Ver db/migrations/live/162_produccion_tareas.sql para el modelo.
//
// Quién hace qué:
//   · Planificar (turnos, programar, delegar, copiar la semana, estimados): dueño/admin y jefe de cocina.
//   · Ver todas las tareas y el panel de tiempos: dueño/admin y jefe.
//   · Staff: sus tareas y las sin responsable de sus plazas/sectores (puede tomarlas).
//   · Ejecutar (iniciar/pausar/terminar, ingredientes): el responsable, o un jefe/dueño/admin.
//   · Aprobar o rechazar un cambio de ingrediente: dueño/admin.
//   · Observaciones: todos los que ven la tarea.
'use strict';

const pool = require('../config/db');
const { sectoresQueConduce } = require('./jefeCocina');
const { sqlEsJefe } = require('./auth/permisos');
const { avisarAlEquipoSinEsperar, createSyncNotification } = require('./notificationService');
const { createOrUpdateProposal, snapshotRecetaElaborado } = require('./recetaProposals');
const { factorConversion, normalizarCantidadUnidad } = require('./unidades');

class ErrorProduccion extends Error {
  constructor(status, code, msg) { super(msg || code); this.status = status; this.code = code; }
}
const fallar = (status, code, msg) => { throw new ErrorProduccion(status, code, msg); };

// ── Helpers puros (tests en produccion.test.js) ──────────────────────────────────────────────
const num = (v) => { if (v === '' || v == null) return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const redondear = (n, d = 3) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Fecha YYYY-MM-DD válida o null. */
function fechaISO(v) {
  const s = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}
function sumarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Lunes de la semana de la fecha (la semana de producción va de lunes a domingo). */
function lunesDe(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0 = domingo
  return sumarDias(iso, dow === 0 ? -6 : 1 - dow);
}
/** Tandas válidas: > 0, de a medio o cualquier decimal razonable (1, ½, 1,5…). */
function tandasValidas(v) {
  const n = num(v);
  return n != null && n > 0 && n <= 999 ? redondear(n, 3) : null;
}
/** Segundos trabajados hasta `ahora`, sumando el tramo en curso. */
function segundosHasta(t, ahora = new Date()) {
  const base = Number(t.segundos_trabajados) || 0;
  if (!t.corriendo_desde) return base;
  return base + Math.max(0, Math.round((ahora - new Date(t.corriendo_desde)) / 1000));
}
/** Ingredientes de la receta escalados a las tandas. */
function escalarItems(items, tandas) {
  const k = Number(tandas) || 1;
  return items.map((it, i) => ({
    receta_item_id: it.id ?? null,
    insumo_id: it.insumo_id ?? null,
    nombre: it.nombre,
    cantidad: it.cantidad == null ? null : redondear(Number(it.cantidad) * k, 4),
    unidad: it.unidad ?? null,
    orden: it.orden ?? i,
  }));
}
/** Copia de una semana a otra: cada tarea mantiene el día de la semana. */
function copiarTareas(tareas, desdeLunes, haciaLunes) {
  const delta = Math.round((new Date(`${haciaLunes}T12:00:00Z`) - new Date(`${desdeLunes}T12:00:00Z`)) / 86400000);
  return tareas.map((t) => ({ ...t, fecha: sumarDias(String(t.fecha).slice(0, 10), delta) }));
}

// ── Contexto de quien pide ───────────────────────────────────────────────────────────────────
async function contextoDe(req) {
  const bizId = Number(req.params.businessId);
  if (!bizId || Number(req.businessId) !== bizId) fallar(403, 'forbidden');
  const uid = Number(req.user?.id);
  const rol = req.businessRole;
  const gestor = rol === 'owner' || rol === 'admin';
  const conduce = rol === 'staff' ? await sectoresQueConduce(uid, bizId) : [];
  const jefe = conduce.length > 0;
  let misSectores = [];
  if (rol === 'staff') {
    const { rows } = await pool.query(
      `SELECT COALESCE(sector_ids, '{}'::int[]) AS s FROM user_assignments
        WHERE user_id = $1 AND scope_type = 'business' AND scope_id = $2 AND revoked_at IS NULL LIMIT 1`, [uid, bizId]);
    misSectores = (rows[0]?.s || []).map(Number);
  }
  if (!gestor && rol !== 'staff') fallar(403, 'forbidden');
  const suc = await resolverSucursal(bizId, req.query?.branchId ?? req.body?.branchId);
  return { bizId, uid, rol, gestor, jefe, planifica: gestor || jefe, decide: gestor, misSectores, suc };
}

/** ?branchId= → sucursal (null = la principal; la is_main también es la principal). Igual que RRHH:
 *  cada sucursal tiene sus turnos, su producción, sus mermas y desperdicios (usuaria 21/11/2026). */
async function resolverSucursal(bizId, raw) {
  if (raw == null || raw === '' || raw === 'main' || raw === 'null') return null;
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) fallar(400, 'sucursal_invalida');
  const { rows } = await pool.query(
    `SELECT id, COALESCE((props->>'is_main')::boolean, FALSE) AS principal FROM app_branches WHERE id = $1 AND business_id = $2`, [id, bizId]);
  if (!rows[0]) fallar(400, 'sucursal_invalida');
  return rows[0].principal ? null : Number(rows[0].id);
}
const exigir = (cond, code = 'forbidden') => { if (!cond) fallar(403, code); };

// ── Equipo, plazas y turnos ──────────────────────────────────────────────────────────────────
async function equipo(bizId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (u.id) u.id, COALESCE(NULLIF(u.display_name, ''), NULLIF(u.name, ''), split_part(u.email, '@', 1)) AS nombre,
            x.role, x.subrol, COALESCE(x.sector_ids, '{}'::int[]) AS sector_ids
       FROM (
         SELECT ua.user_id, ua.role, ua.subrol, ua.sector_ids FROM user_assignments ua
          WHERE ua.revoked_at IS NULL AND ((ua.scope_type = 'business' AND ua.scope_id = $1)
             OR (ua.scope_type = 'organization' AND ua.scope_id = (SELECT organization_id FROM app_businesses WHERE id = $1)))
         UNION ALL
         SELECT owner_id, 'owner', NULL, NULL FROM app_businesses WHERE id = $1 AND owner_id IS NOT NULL
       ) x JOIN app_users u ON u.id = x.user_id
      ORDER BY u.id, CASE x.role WHEN 'staff' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END`, [bizId]);
  return rows.map((r) => ({ id: Number(r.id), nombre: r.nombre, rol: r.role, jefe: r.subrol === 'jefe', sector_ids: (r.sector_ids || []).map(Number) }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}
async function plazas(bizId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.nombre, p.sector_id, s.nombre AS sector FROM plazas p LEFT JOIN sectores s ON s.id = p.sector_id
      WHERE p.business_id = $1 AND p.deleted_at IS NULL ORDER BY s.nombre NULLS LAST, p.orden, p.nombre`, [bizId]);
  return rows.map((r) => ({ id: r.id, nombre: r.nombre, sector_id: r.sector_id, sector: r.sector }));
}
async function turnos(bizId, suc = null) {
  const { rows } = await pool.query(
    `SELECT id, nombre, desde, hasta, orden FROM produccion_turnos WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $2::bigint AND deleted_at IS NULL ORDER BY orden, id`, [bizId, suc]);
  return rows;
}

async function contexto(req) {
  const c = await contextoDe(req);
  let ts = await turnos(c.bizId, c.suc);
  // Primer uso: dos turnos de ejemplo para arrancar (se editan o borran).
  if (!ts.length && c.planifica) {
    await pool.query(
      `INSERT INTO produccion_turnos (business_id, branch_id, nombre, desde, hasta, orden)
       SELECT $1, $2::bigint, n, d, h, o FROM (VALUES ('Mañana','08:00','15:00',0),('Tarde','15:00','23:00',1)) v(n,d,h,o)
        WHERE NOT EXISTS (SELECT 1 FROM produccion_turnos WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $2::bigint)`, [c.bizId, c.suc]);
    ts = await turnos(c.bizId, c.suc);
  }
  const { rows: sectores } = await pool.query(`SELECT id, nombre, es_fijo FROM sectores WHERE business_id = $1 ORDER BY es_fijo DESC, nombre`, [c.bizId]);
  return {
    uid: c.uid, rol: c.rol, jefe: c.jefe, planifica: c.planifica, decide: c.decide,
    turnos: ts, equipo: await equipo(c.bizId), plazas: await plazas(c.bizId), sectores,
  };
}

/** El jefe (o dueño/admin) cambia las áreas que cubre un cocinero: hay negocios donde todos hacen
 *  de todo según el día, o hay que cubrir un puesto. Solo staff común (no jefes ni admins). */
async function asignarAreas(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const userId = Number(req.params.userId);
  const ids = Array.isArray(req.body?.sector_ids) ? [...new Set(req.body.sector_ids.map(Number).filter(Number.isFinite))] : null;
  if (!userId || !ids) fallar(400, 'datos_invalidos');
  const { rows: validos } = await pool.query(`SELECT id FROM sectores WHERE business_id = $1 AND id = ANY($2::int[])`, [c.bizId, ids]);
  if (validos.length !== ids.length) fallar(400, 'sector_invalido');
  const { rows } = await pool.query(
    `UPDATE user_assignments ua SET sector_ids = $3::int[], updated_at = NOW()
      WHERE ua.user_id = $1 AND ua.scope_type = 'business' AND ua.scope_id = $2 AND ua.revoked_at IS NULL
        AND ua.role = 'staff' AND NOT ${sqlEsJefe('ua')}
      RETURNING ua.id`, [userId, c.bizId, ids]);
  if (!rows.length) fallar(409, 'no_editable', 'Solo se cambian las áreas del staff (no de jefes ni administradores)');
  const nombres = (await pool.query(`SELECT nombre FROM sectores WHERE id = ANY($1::int[]) ORDER BY nombre`, [ids])).rows.map((r) => r.nombre);
  if (userId !== c.uid) {
    createSyncNotification({ businessId: c.bizId, userId, type: 'produccion_tarea', title: 'Cambiaron tus áreas de trabajo',
      message: nombres.length ? nombres.join(', ') : 'Sin áreas asignadas', metadata: { kind: 'produccion_areas' } }).catch(() => {});
  }
  return { ok: true, sector_ids: ids };
}

async function guardarTurno(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const b = req.body || {};
  const nombre = String(b.nombre || '').trim().slice(0, 40);
  if (!nombre) fallar(400, 'nombre_requerido');
  const hora = (h) => (/^\d{1,2}:\d{2}$/.test(String(h || '').trim()) ? String(h).trim().padStart(5, '0') : null);
  const id = Number(req.params.turnoId) || null;
  if (id) {
    const { rows } = await pool.query(
      `UPDATE produccion_turnos SET nombre = $1, desde = $2, hasta = $3, orden = COALESCE($4, orden)
        WHERE id = $5 AND business_id = $6 AND deleted_at IS NULL RETURNING *`,
      [nombre, hora(b.desde), hora(b.hasta), num(b.orden), id, c.bizId]);
    if (!rows.length) fallar(404, 'turno_no_encontrado');
    return rows[0];
  }
  const { rows } = await pool.query(
    `INSERT INTO produccion_turnos (business_id, branch_id, nombre, desde, hasta, orden)
     VALUES ($1, $6::bigint, $2, $3, $4, COALESCE($5, (SELECT COALESCE(MAX(orden), -1) + 1 FROM produccion_turnos WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $6::bigint)))
     RETURNING *`, [c.bizId, nombre, hora(b.desde), hora(b.hasta), num(b.orden), c.suc]);
  return rows[0];
}
async function borrarTurno(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const id = Number(req.params.turnoId);
  // Las tareas de ese turno quedan "sin turno" (no se pierden).
  await pool.query(`UPDATE produccion_tareas SET turno_id = NULL WHERE business_id = $1 AND turno_id = $2`, [c.bizId, id]);
  await pool.query(`UPDATE produccion_turnos SET deleted_at = NOW() WHERE id = $1 AND business_id = $2`, [id, c.bizId]);
  return { ok: true };
}

// ── Elaborados que se pueden programar (los que tienen receta) ───────────────────────────────
async function elaborados(req) {
  const c = await contextoDe(req);
  const { rows } = await pool.query(
    `SELECT r.insumo_id, COALESCE(i.nombre, r.nombre) AS nombre, ir.nombre AS rubro,
            r.porciones, COALESCE(r.rendimiento_unidad, 'porcion') AS unidad,
            pe.minutos_tanda, pe.plaza_id, pe.responsable_user_id, pe.dias_vida,
            (SELECT COUNT(*) FROM receta_items ri WHERE ri.receta_id = r.id)::int AS ingredientes,
            -- Promedio de tandas por semana de las últimas 4 semanas (ayuda para programar).
            (SELECT ROUND(SUM(t.tandas) / 4.0, 2) FROM produccion_tareas t
              WHERE t.business_id = r.business_id AND t.branch_id IS NOT DISTINCT FROM $2::bigint AND t.insumo_id = r.insumo_id AND t.deleted_at IS NULL
                AND t.estado = 'hecha' AND t.fecha >= CURRENT_DATE - 28) AS tandas_semana,
            -- Minutos reales promedio por tanda (de lo ya producido).
            (SELECT ROUND(AVG(t.segundos_trabajados / 60.0 / NULLIF(t.tandas, 0)), 1) FROM produccion_tareas t
              WHERE t.business_id = r.business_id AND t.branch_id IS NOT DISTINCT FROM $2::bigint AND t.insumo_id = r.insumo_id AND t.deleted_at IS NULL
                AND t.estado = 'hecha' AND t.segundos_trabajados > 0) AS minutos_reales_tanda
       FROM recetas r
       LEFT JOIN insumos i ON i.id = r.insumo_id
       LEFT JOIN insumo_rubros ir ON ir.business_id = i.business_id AND ir.codigo::text = i.rubro
       LEFT JOIN produccion_elaborados pe ON pe.business_id = r.business_id AND pe.insumo_id = r.insumo_id
      WHERE r.business_id = $1 AND r.insumo_id IS NOT NULL AND r.active = TRUE
      ORDER BY ir.nombre NULLS LAST, 2`, [c.bizId, c.suc]);
  return rows.map((r) => ({
    insumo_id: Number(r.insumo_id), nombre: r.nombre, rubro: r.rubro, rinde_tanda: num(r.porciones), unidad: r.unidad,
    minutos_tanda: num(r.minutos_tanda), plaza_id: r.plaza_id, responsable_user_id: r.responsable_user_id ? Number(r.responsable_user_id) : null,
    ingredientes: r.ingredientes, tandas_semana: num(r.tandas_semana), minutos_reales_tanda: num(r.minutos_reales_tanda), dias_vida: r.dias_vida ?? null,
  }));
}
async function guardarElaborado(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const b = req.body || {};
  const insumoId = Number(req.params.insumoId);
  await pool.query(
    `INSERT INTO produccion_elaborados (business_id, insumo_id, minutos_tanda, plaza_id, responsable_user_id, dias_vida, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (business_id, insumo_id) DO UPDATE SET minutos_tanda = EXCLUDED.minutos_tanda, plaza_id = EXCLUDED.plaza_id,
       responsable_user_id = EXCLUDED.responsable_user_id, dias_vida = EXCLUDED.dias_vida, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [c.bizId, insumoId, num(b.minutos_tanda), Number(b.plaza_id) || null, Number(b.responsable_user_id) || null,
      num(b.dias_vida) != null ? Math.max(0, Math.round(num(b.dias_vida))) : null, c.uid]);
  return { ok: true };
}

// ── Tareas ───────────────────────────────────────────────────────────────────────────────────
const SELECT_TAREA = `
  SELECT t.*, tu.nombre AS turno, p.nombre AS plaza, p.sector_id AS plaza_sector_id,
         COALESCE(NULLIF(u.display_name, ''), NULLIF(u.name, ''), split_part(u.email, '@', 1)) AS responsable,
         (SELECT COUNT(*) FROM produccion_eventos e WHERE e.tarea_id = t.id AND e.tipo = 'nota')::int AS notas
    FROM produccion_tareas t
    LEFT JOIN produccion_turnos tu ON tu.id = t.turno_id
    LEFT JOIN plazas p ON p.id = t.plaza_id
    LEFT JOIN app_users u ON u.id = t.responsable_user_id`;

function formatoTarea(t, ahora = new Date()) {
  return {
    id: Number(t.id), tipo: t.tipo, insumo_id: t.insumo_id ? Number(t.insumo_id) : null, titulo: t.titulo,
    fecha: String(t.fecha instanceof Date ? t.fecha.toISOString() : t.fecha).slice(0, 10),
    turno_id: t.turno_id, turno: t.turno, tandas: num(t.tandas), rinde_esperado: num(t.rinde_esperado), unidad: t.unidad,
    responsable_user_id: t.responsable_user_id ? Number(t.responsable_user_id) : null, responsable: t.responsable,
    plaza_id: t.plaza_id, plaza: t.plaza, sector_id: t.sector_id ?? t.plaza_sector_id ?? null,
    minutos_estimados: num(t.minutos_estimados), estado: t.estado,
    iniciada_at: t.iniciada_at, terminada_at: t.terminada_at, corriendo: !!t.corriendo_desde,
    segundos: segundosHasta(t, ahora), rinde_real: num(t.rinde_real), cambios: t.cambios, notas: t.notas ?? 0, orden: t.orden,
  };
}

/** ¿El staff ve esta tarea? La suya, o sin responsable en una plaza/sector suyo. */
function staffVe(c, t) {
  if (c.planifica) return true;
  if (Number(t.responsable_user_id) === c.uid) return true;
  const sector = t.sector_id ?? t.plaza_sector_id;
  return !t.responsable_user_id && (sector == null || c.misSectores.includes(Number(sector)));
}

async function cargarTarea(id, bizId, client = pool) {
  const { rows } = await client.query(`${SELECT_TAREA} WHERE t.id = $1 AND t.business_id = $2 AND t.deleted_at IS NULL`, [id, bizId]);
  return rows[0] || null;
}

async function listarTareas(req) {
  const c = await contextoDe(req);
  await sincronizarPropuestas(c.bizId);
  const desde = fechaISO(req.query.desde) || lunesDe(new Date().toISOString().slice(0, 10));
  const hasta = fechaISO(req.query.hasta) || sumarDias(desde, 6);
  const { rows } = await pool.query(
    `${SELECT_TAREA} WHERE t.business_id = $1 AND t.branch_id IS NOT DISTINCT FROM $4::bigint AND t.deleted_at IS NULL AND t.fecha BETWEEN $2 AND $3
      ORDER BY t.fecha, tu.orden NULLS LAST, t.orden, t.id`, [c.bizId, desde, hasta, c.suc]);
  const ahora = new Date();
  return { desde, hasta, tareas: rows.filter((t) => staffVe(c, t)).map((t) => formatoTarea(t, ahora)) };
}

/** Arma los valores de una tarea a partir del pedido + el elaborado (rinde, estimado, sugeridos). */
async function armarTarea(c, b) {
  const fecha = fechaISO(b.fecha);
  if (!fecha) fallar(400, 'fecha_invalida');
  const tipo = b.tipo === 'mise_en_place' ? 'mise_en_place' : b.insumo_id ? 'produccion' : 'otra';
  let titulo = String(b.titulo || '').trim().slice(0, 120);
  let rinde = null, unidad = null, minutos = num(b.minutos_estimados), plaza = Number(b.plaza_id) || null, resp = Number(b.responsable_user_id) || null;
  const tandas = tipo === 'produccion' ? tandasValidas(b.tandas ?? 1) : 1;
  if (tipo === 'produccion') {
    if (!tandas) fallar(400, 'tandas_invalidas');
    const { rows } = await pool.query(
      `SELECT COALESCE(i.nombre, r.nombre) AS nombre, r.porciones, COALESCE(r.rendimiento_unidad, 'porcion') AS unidad,
              pe.minutos_tanda, pe.plaza_id, pe.responsable_user_id
         FROM recetas r LEFT JOIN insumos i ON i.id = r.insumo_id
         LEFT JOIN produccion_elaborados pe ON pe.business_id = r.business_id AND pe.insumo_id = r.insumo_id
        WHERE r.business_id = $1 AND r.insumo_id = $2 AND r.active = TRUE LIMIT 1`, [c.bizId, Number(b.insumo_id)]);
    const e = rows[0];
    if (!e) fallar(400, 'elaborado_sin_receta');
    titulo = titulo || e.nombre;
    rinde = num(e.porciones) != null ? redondear(num(e.porciones) * tandas, 3) : null;
    unidad = e.unidad;
    if (minutos == null && num(e.minutos_tanda) != null) minutos = redondear(num(e.minutos_tanda) * tandas, 1);
    if (!('plaza_id' in b)) plaza = e.plaza_id || null;
    if (!('responsable_user_id' in b)) resp = e.responsable_user_id ? Number(e.responsable_user_id) : null;
  }
  let sector = null;
  if (plaza) {
    const { rows } = await pool.query(`SELECT sector_id, nombre FROM plazas WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`, [plaza, c.bizId]);
    if (!rows.length) plaza = null; else { sector = rows[0].sector_id; if (tipo === 'mise_en_place') titulo = `Mise en place · ${rows[0].nombre}`; }
  }
  if (tipo === 'mise_en_place' && !plaza) fallar(400, 'plaza_requerida', 'Elegí la plaza');
  if (!titulo) fallar(400, 'titulo_requerido');
  return { tipo, insumo_id: tipo === 'produccion' ? Number(b.insumo_id) : null, titulo, fecha, turno_id: Number(b.turno_id) || null,
    tandas, rinde_esperado: rinde, unidad, responsable_user_id: resp, plaza_id: plaza, sector_id: sector, minutos_estimados: minutos };
}

async function insertarTarea(client, c, v) {
  const { rows } = await client.query(
    `INSERT INTO produccion_tareas (business_id, tipo, insumo_id, titulo, fecha, turno_id, tandas, rinde_esperado, unidad,
       responsable_user_id, plaza_id, sector_id, minutos_estimados, creada_por, branch_id, orden)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::bigint,
       (SELECT COALESCE(MAX(orden), -1) + 1 FROM produccion_tareas WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $15::bigint AND fecha = $5))
     RETURNING id`,
    [c.bizId, v.tipo, v.insumo_id, v.titulo, v.fecha, v.turno_id, v.tandas, v.rinde_esperado, v.unidad,
      v.responsable_user_id, v.plaza_id, v.sector_id, v.minutos_estimados, c.uid, c.suc]);
  return Number(rows[0].id);
}

/** Un aviso por persona con lo que le asignaron (agrupa la carga de una semana entera). */
async function avisarAsignadas(bizId, actor, porPersona) {
  for (const [uid, lista] of porPersona) {
    if (!uid || uid === actor) continue;
    const n = lista.length;
    const title = n === 1 ? `Te asignaron: ${lista[0].titulo}` : `Te asignaron ${n} tareas de producción`;
    const dias = [...new Set(lista.map((t) => t.fecha))].sort();
    createSyncNotification({ businessId: bizId, userId: uid, type: 'produccion_tarea', title,
      message: n === 1 ? `Para el ${dias[0]}` : `Del ${dias[0]} al ${dias[dias.length - 1]}`,
      metadata: { kind: 'produccion_tarea', ids: lista.map((t) => t.id), fecha: dias[0] } }).catch((e) => console.error('[produccion aviso]', e.message));
  }
}

async function crearTareas(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const lista = Array.isArray(req.body?.tareas) ? req.body.tareas : [req.body || {}];
  if (!lista.length || lista.length > 500) fallar(400, 'lista_invalida');
  const valores = [];
  for (const b of lista) valores.push(await armarTarea(c, b));
  const client = await pool.connect();
  const ids = [];
  try {
    await client.query('BEGIN');
    for (const v of valores) {
      const id = await insertarTarea(client, c, v);
      ids.push(id);
      await client.query(`INSERT INTO produccion_eventos (tarea_id, user_id, tipo, texto) VALUES ($1, $2, 'edicion', 'Programó la tarea')`, [id, c.uid]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  const porPersona = new Map();
  valores.forEach((v, i) => { if (v.responsable_user_id) porPersona.set(v.responsable_user_id, [...(porPersona.get(v.responsable_user_id) || []), { ...v, id: ids[i] }]); });
  avisarAsignadas(c.bizId, c.uid, porPersona);
  return { ids };
}

async function editarTarea(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const id = Number(req.params.id);
  const t = await cargarTarea(id, c.bizId);
  if (!t) fallar(404, 'tarea_no_encontrada');
  const b = req.body || {};
  const set = [], vals = [];
  const poner = (col, v) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
  const cambios = [];
  if ('fecha' in b) { const f = fechaISO(b.fecha); if (!f) fallar(400, 'fecha_invalida'); poner('fecha', f); }
  if ('turno_id' in b) poner('turno_id', Number(b.turno_id) || null);
  if ('orden' in b) poner('orden', Number(b.orden) || 0);
  if ('titulo' in b && t.tipo === 'otra') { const s = String(b.titulo || '').trim().slice(0, 120); if (!s) fallar(400, 'titulo_requerido'); poner('titulo', s); }
  if ('minutos_estimados' in b) poner('minutos_estimados', num(b.minutos_estimados));
  if ('tandas' in b && t.tipo === 'produccion') {
    if (t.estado !== 'pendiente') fallar(409, 'ya_iniciada', 'La tarea ya empezó: no se cambian las tandas');
    const k = tandasValidas(b.tandas); if (!k) fallar(400, 'tandas_invalidas');
    const viejas = num(t.tandas) || 1;
    poner('tandas', k);
    if (num(t.rinde_esperado) != null) poner('rinde_esperado', redondear(num(t.rinde_esperado) / viejas * k, 3));
    if (!('minutos_estimados' in b) && num(t.minutos_estimados) != null) poner('minutos_estimados', redondear(num(t.minutos_estimados) / viejas * k, 1));
    cambios.push(`tandas ${viejas} → ${k}`);
  }
  if ('plaza_id' in b) {
    const plaza = Number(b.plaza_id) || null; let sector = null;
    if (plaza) { const { rows } = await pool.query(`SELECT sector_id FROM plazas WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`, [plaza, c.bizId]); if (!rows.length) fallar(400, 'plaza_invalida'); sector = rows[0].sector_id; }
    poner('plaza_id', plaza); poner('sector_id', sector);
  }
  let nuevoResp = null;
  if ('responsable_user_id' in b) {
    const r = Number(b.responsable_user_id) || null;
    poner('responsable_user_id', r);
    if (r && r !== Number(t.responsable_user_id)) { nuevoResp = r; cambios.push('cambió el responsable'); }
  }
  if (!set.length) return formatoTarea(t);
  poner('updated_at', new Date());
  vals.push(id, c.bizId);
  await pool.query(`UPDATE produccion_tareas SET ${set.join(', ')} WHERE id = $${vals.length - 1} AND business_id = $${vals.length}`, vals);
  if (cambios.length) await pool.query(`INSERT INTO produccion_eventos (tarea_id, user_id, tipo, texto) VALUES ($1, $2, 'edicion', $3)`, [id, c.uid, cambios.join(' · ')]);
  const nueva = await cargarTarea(id, c.bizId);
  if (nuevoResp) avisarAsignadas(c.bizId, c.uid, new Map([[nuevoResp, [formatoTarea(nueva)]]]));
  return formatoTarea(nueva);
}

async function borrarTarea(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const t = await cargarTarea(Number(req.params.id), c.bizId);
  if (!t) fallar(404, 'tarea_no_encontrada');
  // Jefe / dueño / admin borran en cualquier estado (se cargó, se hizo o se cambió mal: usuaria
  // 21/11/2026). Borrada, deja de contar en Consumos y en el Panel; queda en el historial.
  const motivo = String(req.body?.motivo || '').trim().slice(0, 200);
  await pool.query(`UPDATE produccion_tareas SET deleted_at = NOW(), corriendo_desde = NULL WHERE id = $1`, [t.id]);
  await evento(pool, t.id, c.uid, 'edicion', `Borró la tarea${t.estado !== 'pendiente' ? ` (estaba ${t.estado.replace('_', ' ')})` : ''}${motivo ? `: ${motivo}` : ''}`);
  // Un cambio de receta que esperaba aprobación por esta tarea se retira de Aprobaciones.
  const { rows: props } = await pool.query(
    `SELECT DISTINCT proposal_id FROM produccion_tarea_insumos WHERE tarea_id = $1 AND proposal_id IS NOT NULL AND cambio = 'pendiente'`, [t.id]);
  for (const p of props) {
    const { rows: otros } = await pool.query(
      `SELECT 1 FROM produccion_tarea_insumos x JOIN produccion_tareas o ON o.id = x.tarea_id
        WHERE x.proposal_id = $1 AND o.id <> $2 AND o.deleted_at IS NULL LIMIT 1`, [p.proposal_id, t.id]);
    if (!otros.length) await pool.query(`DELETE FROM receta_proposals WHERE id = $1 AND status = 'pending'`, [p.proposal_id]);
  }
  if (props.length && t.insumo_id) {
    await pool.query(
      `UPDATE recetas r SET has_pending_proposal = EXISTS (SELECT 1 FROM receta_proposals p WHERE p.receta_id = r.id AND p.status IN ('pending','in_revision'))
        WHERE r.business_id = $1 AND r.insumo_id = $2 AND r.active = TRUE`, [c.bizId, t.insumo_id]);
  }
  return { ok: true };
}

/** Repetir una semana en otra (la producción se repite mucho): copia las tareas no canceladas,
 *  todas como pendientes, con el mismo responsable, plaza, turno y tandas. Sin `pisar`, si la
 *  semana destino ya tiene tareas no hace nada (para no duplicar). */
async function copiarSemana(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const desde = fechaISO(req.body?.desde), hacia = fechaISO(req.body?.hacia);
  if (!desde || !hacia) fallar(400, 'fechas_invalidas');
  const dL = lunesDe(desde), hL = lunesDe(hacia);
  if (dL === hL) fallar(400, 'misma_semana');
  const { rows: ya } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM produccion_tareas WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $4::bigint AND deleted_at IS NULL AND fecha BETWEEN $2 AND $3`, [c.bizId, hL, sumarDias(hL, 6), c.suc]);
  if (ya[0].n && !req.body?.sumar) fallar(409, 'semana_con_tareas', `La semana destino ya tiene ${ya[0].n} tareas`);
  const { rows } = await pool.query(
    `SELECT * FROM produccion_tareas WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $4::bigint AND deleted_at IS NULL AND estado <> 'cancelada' AND fecha BETWEEN $2 AND $3 ORDER BY fecha, orden, id`,
    [c.bizId, dL, sumarDias(dL, 6), c.suc]);
  if (!rows.length) fallar(404, 'semana_vacia', 'La semana de origen no tiene tareas');
  const nuevas = copiarTareas(rows, dL, hL);
  const client = await pool.connect();
  const porPersona = new Map();
  try {
    await client.query('BEGIN');
    for (const t of nuevas) {
      const v = { tipo: t.tipo, insumo_id: t.insumo_id, titulo: t.titulo, fecha: t.fecha, turno_id: t.turno_id, tandas: t.tandas,
        rinde_esperado: t.rinde_esperado, unidad: t.unidad, responsable_user_id: t.responsable_user_id, plaza_id: t.plaza_id,
        sector_id: t.sector_id, minutos_estimados: t.minutos_estimados };
      const id = await insertarTarea(client, c, v);
      await client.query(`INSERT INTO produccion_eventos (tarea_id, user_id, tipo, texto) VALUES ($1, $2, 'edicion', $3)`, [id, c.uid, `Copiada de la semana del ${dL}`]);
      if (v.responsable_user_id) { const k = Number(v.responsable_user_id); porPersona.set(k, [...(porPersona.get(k) || []), { ...v, id }]); }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  avisarAsignadas(c.bizId, c.uid, porPersona);
  return { copiadas: nuevas.length, desde: hL, hasta: sumarDias(hL, 6) };
}

// ── Detalle y ejecución ──────────────────────────────────────────────────────────────────────
async function itemsReceta(bizId, insumoId) {
  const { rows } = await pool.query(
    `SELECT ri.id, ri.insumo_id, COALESCE(i.nombre, ri.nombre_insumo_maxi, '(sin nombre)') AS nombre, ri.cantidad, ri.unidad, ri.orden
       FROM recetas r JOIN receta_items ri ON ri.receta_id = r.id LEFT JOIN insumos i ON i.id = ri.insumo_id
      WHERE r.business_id = $1 AND r.insumo_id = $2 AND r.active = TRUE
      ORDER BY ri.orden NULLS LAST, ri.id`, [bizId, insumoId]);
  return rows;
}
/** Plantilla de mise en place de una plaza (como si fuera una receta de 1 tanda). */
async function itemsMise(bizId, plazaId) {
  if (!plazaId) return [];
  const { rows } = await pool.query(
    `SELECT id, insumo_id, nombre, cantidad, unidad, orden FROM produccion_mise WHERE business_id = $1 AND plaza_id = $2 ORDER BY orden, id`, [bizId, plazaId]);
  return rows.map((r) => ({ receta_item_id: null, insumo_id: r.insumo_id ? Number(r.insumo_id) : null, nombre: r.nombre, cantidad: num(r.cantidad), unidad: r.unidad, orden: r.orden }));
}
/** Lote de una producción: L + fecha (AAMMDD) + número de tarea. */
function loteDe(t) {
  const f = String(t.fecha instanceof Date ? t.fecha.toISOString() : t.fecha).slice(0, 10).replace(/-/g, '').slice(2);
  return `L${f}-${t.id}`;
}
async function pasosReceta(bizId, insumoId) {
  const { rows } = await pool.query(
    `SELECT r.pasos, r.foto, r.fotos, r.notas, r.almacenamiento_heladera, r.almacenamiento_freezer
       FROM recetas r WHERE r.business_id = $1 AND r.insumo_id = $2 AND r.active = TRUE LIMIT 1`, [bizId, insumoId]);
  return rows[0] || null;
}

async function detalle(req) {
  const c = await contextoDe(req);
  await sincronizarPropuestas(c.bizId);
  const t = await cargarTarea(Number(req.params.id), c.bizId);
  if (!t || !staffVe(c, t)) fallar(404, 'tarea_no_encontrada');
  let insumos;
  if (t.estado === 'pendiente' && t.insumo_id) {
    // Todavía no empezó: la receta de hoy escalada (se fija al iniciar).
    insumos = escalarItems(await itemsReceta(c.bizId, t.insumo_id), t.tandas).map((x) => ({ ...x, id: null, usado: false }));
  } else if (t.estado === 'pendiente' && t.tipo === 'mise_en_place') {
    insumos = (await itemsMise(c.bizId, t.plaza_id)).map((x) => ({ ...x, id: null, usado: false }));
  } else {
    const { rows } = await pool.query(`SELECT * FROM produccion_tarea_insumos WHERE tarea_id = $1 ORDER BY orden, id`, [t.id]);
    insumos = rows.map(formatoInsumo);
  }
  const { rows: eventos } = await pool.query(
    `SELECT e.id, e.tipo, e.texto, e.metadata, e.created_at, e.user_id,
            COALESCE(NULLIF(u.display_name, ''), NULLIF(u.name, ''), split_part(u.email, '@', 1)) AS autor
       FROM produccion_eventos e LEFT JOIN app_users u ON u.id = e.user_id WHERE e.tarea_id = $1 ORDER BY e.created_at, e.id`, [t.id]);
  const receta = t.insumo_id ? await pasosReceta(c.bizId, t.insumo_id) : null;
  let etiqueta = null;
  if (t.insumo_id) {
    const { rows: pe } = await pool.query(`SELECT dias_vida FROM produccion_elaborados WHERE business_id = $1 AND insumo_id = $2`, [c.bizId, t.insumo_id]);
    etiqueta = {
      lote: loteDe(t), dias_vida: pe[0]?.dias_vida ?? null,
      heladera: receta?.almacenamiento_heladera || null, freezer: receta?.almacenamiento_freezer || null,
    };
  }
  return {
    tarea: formatoTarea(t), insumos, eventos, receta, etiqueta,
    puede: { ejecutar: puedeEjecutar(c, t), planificar: c.planifica, decidir: c.decide },
  };
}
function formatoInsumo(r) {
  return {
    id: Number(r.id), receta_item_id: r.receta_item_id, insumo_id: r.insumo_id ? Number(r.insumo_id) : null, nombre: r.nombre,
    cantidad: num(r.cantidad), unidad: r.unidad, insumo_real_id: r.insumo_real_id ? Number(r.insumo_real_id) : null,
    nombre_real: r.nombre_real, cantidad_real: num(r.cantidad_real), unidad_real: r.unidad_real,
    falta: r.falta, agregado: r.agregado, usado: r.usado, motivo: r.motivo, cambio: r.cambio,
    alcance: r.alcance || 'produccion', proposal_id: r.proposal_id ? Number(r.proposal_id) : null,
    decidido_at: r.decidido_at, nota_decision: r.nota_decision, orden: r.orden,
  };
}

// ── Cambio permanente de receta (alcance 'receta') ───────────────────────────────────────────
// El cocinero dice que la receta cambió (no se usa más un insumo, se usa otro, otra cantidad, uno
// nuevo). Se arma una propuesta de receta con el circuito de siempre (receta_proposals): el
// dueño/admin la ve en Aprobaciones con el antes/después y el costo, y la aprueba o la rechaza.
// Las cantidades de la producción están escaladas a las tandas: a la receta van por 1 tanda.

/** Puro: cuerpo de la receta (formato de writeElaboradoReceta) con los cambios aplicados. */
function cuerpoPropuesta(receta, items, cambios, tandas, costos = new Map()) {
  const k = Number(tandas) > 0 ? Number(tandas) : 1;
  const porItem = new Map(cambios.filter((x) => !x.agregado && x.receta_item_id).map((x) => [Number(x.receta_item_id), x]));
  const base = (x) => ({
    supplyId: x.article_ref_id ? null : (x.insumo_id || x.supply_id || null),
    articleRefId: x.article_ref_id || null,
    cantidad: Number(x.cantidad), unidad: x.unidad, costoUnitario: Number(x.costo_unitario) || 0,
    notas: x.notas, observaciones: x.observaciones, merma: x.merma, pedido: x.pedido, tipoCosto: x.tipo_costo, orden: x.orden,
    mermaIds: Array.isArray(x.merma_ids) && x.merma_ids.length ? x.merma_ids : (x.merma_id != null ? [x.merma_id] : []),
    secreto: x.secreto === true, fotosUrls: Array.isArray(x.fotos_urls) ? x.fotos_urls : [],
  });
  const costoDe = (insumoId, unidad) => {
    const c = costos.get(Number(insumoId));
    if (!c) return 0;
    const f = factorConversion(unidad || c.unidad_med, c.unidad_med || unidad);
    return (Number(c.precio_ref) || 0) * (Number.isFinite(f) ? f : 1);
  };
  const salida = [];
  for (const x of items) {
    const cam = porItem.get(Number(x.id));
    if (!cam) { salida.push(base(x)); continue; }
    if (cam.falta) continue; // ya no va en la receta
    const it = base(x);
    const unidad = cam.unidad_real || x.unidad;
    const cant = cam.cantidad_real != null ? Number(cam.cantidad_real) / k : Number(x.cantidad);
    if (cam.insumo_real_id && Number(cam.insumo_real_id) !== Number(x.insumo_id)) {
      it.supplyId = Number(cam.insumo_real_id); it.articleRefId = null; it.costoUnitario = costoDe(cam.insumo_real_id, unidad);
    } else if (unidad !== x.unidad) {
      const f = factorConversion(unidad, x.unidad);
      it.costoUnitario = (Number(x.costo_unitario) || 0) * (Number.isFinite(f) ? f : 1);
    }
    const n = normalizarCantidadUnidad(cant, unidad, it.costoUnitario);
    Object.assign(it, { cantidad: redondear(n.cantidad, 4), unidad: n.unidad, costoUnitario: n.costoUnitario });
    salida.push(it);
  }
  let orden = salida.reduce((m, x) => Math.max(m, Number(x.orden) || 0), 0);
  for (const cam of cambios.filter((x) => x.agregado && x.insumo_real_id)) {
    const unidad = cam.unidad_real || null;
    const n = normalizarCantidadUnidad(Number(cam.cantidad_real) / k, unidad, costoDe(cam.insumo_real_id, unidad));
    salida.push({ supplyId: Number(cam.insumo_real_id), articleRefId: null, cantidad: redondear(n.cantidad, 4), unidad: n.unidad,
      costoUnitario: n.costoUnitario, notas: null, observaciones: null, merma: null, pedido: null, tipoCosto: null, orden: ++orden,
      mermaIds: [], secreto: false, fotosUrls: [] });
  }
  return {
    nombre: receta.nombre, descripcion: receta.descripcion, porciones: receta.porciones, porcentajeVenta: receta.porcentaje_venta,
    rendimientoUnidad: receta.rendimiento_unidad, rendimientoPeso: receta.rendimiento_peso, unidadPeso: receta.unidad_peso,
    notas: receta.notas, foto: receta.foto, fotos: receta.fotos, notasUpdatedAt: receta.notas_updated_at,
    metodoCoccion: receta.metodo_coccion, temperatura: receta.temperatura, tiempoMin: receta.tiempo_min, pasos: receta.pasos,
    almacenamientoFreezer: receta.almacenamiento_freezer, almacenamientoHeladera: receta.almacenamiento_heladera,
    items: salida,
  };
}

/** Arma (o actualiza) la propuesta con todos los cambios permanentes pendientes de la tarea.
 *  Sin ninguno, retira la propuesta que había armado. */
async function proponerReceta(c, tv, nombreAviso) {
  const { rows: cambios } = await pool.query(
    `SELECT * FROM produccion_tarea_insumos WHERE tarea_id = $1 AND alcance = 'receta' AND cambio = 'pendiente' ORDER BY id`, [tv.id]);
  const { rows: previas } = await pool.query(
    `SELECT DISTINCT proposal_id FROM produccion_tarea_insumos WHERE tarea_id = $1 AND proposal_id IS NOT NULL`, [tv.id]);
  if (!cambios.length) {
    for (const p of previas) {
      await pool.query(`DELETE FROM receta_proposals WHERE id = $1 AND status = 'pending' AND created_by_user_id = $2`, [p.proposal_id, c.uid]);
    }
    await pool.query(
      `UPDATE recetas r SET has_pending_proposal = EXISTS (SELECT 1 FROM receta_proposals p WHERE p.receta_id = r.id AND p.status IN ('pending','in_revision'))
        WHERE r.business_id = $1 AND r.insumo_id = $2 AND r.active = TRUE`, [c.bizId, tv.insumo_id]);
    return null;
  }
  const { rows: recs } = await pool.query(`SELECT * FROM recetas WHERE business_id = $1 AND insumo_id = $2 AND active = TRUE LIMIT 1`, [c.bizId, tv.insumo_id]);
  if (!recs.length) fallar(409, 'elaborado_sin_receta');
  const { rows: items } = await pool.query(`SELECT * FROM receta_items WHERE receta_id = $1 ORDER BY orden NULLS LAST, id`, [recs[0].id]);
  const ids = [...new Set(cambios.map((x) => Number(x.insumo_real_id)).filter(Boolean))];
  const costos = new Map();
  if (ids.length) {
    const { rows } = await pool.query(`SELECT id, precio_ref, unidad_med FROM insumos WHERE id = ANY($1::bigint[])`, [ids]);
    for (const r of rows) costos.set(Number(r.id), r);
  }
  const body = cuerpoPropuesta(recs[0], items, cambios, tv.tandas, costos);
  const before = await snapshotRecetaElaborado(tv.insumo_id, c.bizId);
  const prop = await createOrUpdateProposal({ bizId: c.bizId, insumoId: Number(tv.insumo_id), uid: c.uid, body, snapshotBefore: before, nombreParaAviso: nombreAviso });
  if (prop?.id) {
    await pool.query(`UPDATE produccion_tarea_insumos SET proposal_id = $1 WHERE id = ANY($2::bigint[])`, [prop.id, cambios.map((x) => x.id)]);
  }
  return prop;
}

/** Los cambios permanentes toman la decisión de su propuesta (aprobada/rechazada en Aprobaciones). */
async function sincronizarPropuestas(bizId) {
  const { rows } = await pool.query(
    `UPDATE produccion_tarea_insumos x
        SET cambio = CASE p.status WHEN 'approved' THEN 'aprobado' ELSE 'rechazado' END,
            decidido_por = p.decided_by, decidido_at = COALESCE(p.decided_at, NOW()), nota_decision = p.admin_comment
       FROM receta_proposals p, produccion_tareas t
      WHERE x.proposal_id = p.id AND x.tarea_id = t.id AND t.business_id = $1
        AND x.cambio = 'pendiente' AND p.status IN ('approved', 'rejected')
      RETURNING x.tarea_id, x.nombre, x.nombre_real, x.agregado, p.status, p.decided_by`, [bizId]);
  const porTarea = new Map();
  for (const r of rows) porTarea.set(Number(r.tarea_id), [...(porTarea.get(Number(r.tarea_id)) || []), r]);
  for (const [tareaId, lista] of porTarea) {
    for (const r of lista) {
      await evento(pool, tareaId, r.decided_by, 'decision',
        `${r.status === 'approved' ? 'Aprobó' : 'Rechazó'} el cambio en la receta: ${r.agregado ? r.nombre_real : r.nombre}`, { origen: 'aprobaciones' });
    }
    await refrescarCambios(tareaId);
  }
}

/** Insumos para elegir el reemplazo (los del negocio principal si es una sucursal de un grupo). */
async function bizInsumos(bizId) {
  const { rows } = await pool.query('SELECT created_from, organization_id FROM app_businesses WHERE id = $1', [bizId]);
  const b = rows[0];
  if (!b || b.created_from !== 'from_group' || !b.organization_id) return bizId;
  const { rows: r } = await pool.query(
    `SELECT id FROM app_businesses WHERE organization_id = $1 AND (created_from IS NULL OR created_from IN ('manual','onboarding')) ORDER BY id LIMIT 1`, [b.organization_id]);
  return Number(r[0]?.id ?? bizId);
}
async function buscarInsumos(req) {
  const c = await contextoDe(req);
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) return [];
  const { rows } = await pool.query(
    `SELECT id, nombre, unidad_med FROM insumos
      WHERE business_id = $1 AND COALESCE(activo, TRUE) AND nombre ILIKE '%' || $2 || '%'
      ORDER BY (nombre ILIKE $2 || '%') DESC, nombre LIMIT 20`, [await bizInsumos(c.bizId), q]);
  return rows.map((r) => ({ id: Number(r.id), nombre: r.nombre, unidad: r.unidad_med }));
}
const puedeEjecutar = (c, t) => c.planifica || Number(t.responsable_user_id) === c.uid || (!t.responsable_user_id && staffVe(c, t));

async function evento(client, tareaId, uid, tipo, texto, metadata = {}) {
  await client.query(`INSERT INTO produccion_eventos (tarea_id, user_id, tipo, texto, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [tareaId, uid, tipo, texto, JSON.stringify(metadata)]);
}

/** iniciar | pausar | reanudar | terminar | reabrir | cancelar */
async function accion(req) {
  const c = await contextoDe(req);
  const id = Number(req.params.id);
  const que = String(req.params.accion);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM produccion_tareas WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, c.bizId]);
    const t = rows[0];
    if (!t) fallar(404, 'tarea_no_encontrada');
    const tv = await cargarTarea(id, c.bizId, client);
    if (!staffVe(c, tv) || !puedeEjecutar(c, tv)) fallar(403, 'forbidden');
    const ahora = new Date();
    if (que === 'iniciar' || que === 'reanudar') {
      if (!['pendiente', 'pausada'].includes(t.estado)) fallar(409, 'estado_invalido');
      if (t.estado === 'pendiente') {
        // Se fija la receta escalada: lo que se use desde acá queda en la tarea.
        if (t.insumo_id || t.tipo === 'mise_en_place') {
          const items = t.insumo_id ? escalarItems(await itemsReceta(c.bizId, t.insumo_id), t.tandas) : await itemsMise(c.bizId, t.plaza_id);
          for (const it of items) {
            await client.query(
              `INSERT INTO produccion_tarea_insumos (tarea_id, receta_item_id, insumo_id, nombre, cantidad, unidad, orden) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [id, it.receta_item_id, it.insumo_id, it.nombre, it.cantidad, it.unidad, it.orden]);
          }
        }
      }
      await client.query(
        `UPDATE produccion_tareas SET estado = 'en_curso', iniciada_at = COALESCE(iniciada_at, NOW()), corriendo_desde = NOW(),
           responsable_user_id = COALESCE(responsable_user_id, $2), updated_at = NOW() WHERE id = $1`, [id, c.uid]);
      await evento(client, id, c.uid, 'estado', t.estado === 'pendiente' ? 'Empezó' : 'Retomó');
    } else if (que === 'pausar') {
      if (t.estado !== 'en_curso') fallar(409, 'estado_invalido');
      await client.query(
        `UPDATE produccion_tareas SET estado = 'pausada', segundos_trabajados = $2, corriendo_desde = NULL, updated_at = NOW() WHERE id = $1`,
        [id, segundosHasta(t, ahora)]);
      await evento(client, id, c.uid, 'estado', 'Pausó');
    } else if (que === 'terminar') {
      if (!['en_curso', 'pausada'].includes(t.estado)) fallar(409, 'estado_invalido');
      const rinde = num(req.body?.rinde_real);
      if (t.tipo === 'produccion' && (rinde == null || rinde < 0)) fallar(400, 'rinde_requerido', 'Cargá cuánto rindió');
      // Lo que no se tildó se da por usado tal cual (como en la planilla: «finalizar» confirma todo).
      await client.query(`UPDATE produccion_tarea_insumos SET usado = TRUE WHERE tarea_id = $1 AND NOT falta`, [id]);
      await client.query(
        `UPDATE produccion_tareas SET estado = 'hecha', segundos_trabajados = $2, corriendo_desde = NULL, terminada_at = NOW(),
           rinde_real = $3, updated_at = NOW() WHERE id = $1`, [id, segundosHasta(t, ahora), rinde]);
      await evento(client, id, c.uid, 'estado', t.tipo === 'produccion' ? `Terminó · rindió ${rinde}${t.unidad ? ` ${t.unidad}` : ''}` : 'Terminó', { rinde_real: rinde });
    } else if (que === 'reabrir') {
      exigir(c.planifica);
      if (t.estado !== 'hecha' && t.estado !== 'cancelada') fallar(409, 'estado_invalido');
      await client.query(`UPDATE produccion_tareas SET estado = CASE WHEN iniciada_at IS NULL THEN 'pendiente' ELSE 'pausada' END, terminada_at = NULL, updated_at = NOW() WHERE id = $1`, [id]);
      await evento(client, id, c.uid, 'estado', 'Reabrió la tarea');
    } else if (que === 'cancelar') {
      exigir(c.planifica);
      if (t.estado === 'hecha') fallar(409, 'estado_invalido');
      await client.query(`UPDATE produccion_tareas SET estado = 'cancelada', segundos_trabajados = $2, corriendo_desde = NULL, updated_at = NOW() WHERE id = $1`, [id, segundosHasta(t, ahora)]);
      await evento(client, id, c.uid, 'estado', `Canceló la tarea${req.body?.motivo ? `: ${String(req.body.motivo).slice(0, 200)}` : ''}`);
    } else fallar(400, 'accion_invalida');
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  return detalle(req);
}

/** Puro: factor y tandas nuevas a partir de la cantidad que hay de un ingrediente. */
function escalarPorIngrediente(tandas, cantidadReceta, cantidadHay) {
  const base = Number(cantidadReceta), hay = Number(cantidadHay), k = Number(tandas) || 1;
  if (!(base > 0) || !(hay > 0)) return null;
  const factor = hay / base;
  return { factor, tandas: redondear(k * factor, 3) };
}

/** «Hay 51 kg y la receta pide 55»: recalcula TODA la fórmula en proporción (tandas, cada
 *  ingrediente, rinde esperado y tiempo estimado). Antes de empezar o en curso. */
async function escalar(req) {
  const c = await contextoDe(req);
  const id = Number(req.params.id);
  const tv = await cargarTarea(id, c.bizId);
  if (!tv || !staffVe(c, tv)) fallar(404, 'tarea_no_encontrada');
  if (!puedeEjecutar(c, tv)) fallar(403, 'forbidden');
  if (tv.tipo !== 'produccion') fallar(400, 'solo_elaborados');
  if (['hecha', 'cancelada'].includes(tv.estado)) fallar(409, 'estado_invalido');
  const b = req.body || {};
  const hay = num(b.cantidad);
  let item;
  if (tv.estado === 'pendiente') {
    item = escalarItems(await itemsReceta(c.bizId, tv.insumo_id), tv.tandas).find((x) => Number(x.receta_item_id) === Number(b.receta_item_id));
  } else {
    const { rows } = await pool.query(`SELECT * FROM produccion_tarea_insumos WHERE id = $1 AND tarea_id = $2 AND NOT agregado`, [Number(b.item_id), id]);
    item = rows[0] ? { ...rows[0], cantidad: num(rows[0].cantidad) } : null;
  }
  if (!item) fallar(404, 'insumo_no_encontrado');
  const r = escalarPorIngrediente(tv.tandas, item.cantidad, hay);
  if (!r || r.tandas <= 0) fallar(400, 'cantidad_invalida', 'Poné cuánto hay');
  await pool.query(
    `UPDATE produccion_tareas SET tandas = $2, rinde_esperado = CASE WHEN rinde_esperado IS NULL THEN NULL ELSE ROUND(rinde_esperado * $3, 3) END,
       minutos_estimados = CASE WHEN minutos_estimados IS NULL THEN NULL ELSE ROUND(minutos_estimados * $3, 1) END, updated_at = NOW()
      WHERE id = $1`, [id, r.tandas, r.factor]);
  if (tv.estado !== 'pendiente') {
    // Ya empezada: la receta fijada se recalcula (los cambios del cocinero quedan como están).
    await pool.query(`UPDATE produccion_tarea_insumos SET cantidad = ROUND(cantidad * $2, 4) WHERE tarea_id = $1 AND NOT agregado AND cantidad IS NOT NULL`, [id, r.factor]);
  }
  await evento(pool, id, c.uid, 'edicion',
    `Recalculó toda la receta para ${hay} ${item.unidad || ''} de ${item.nombre}: ${num(tv.tandas)} → ${r.tandas} tandas`, { factor: r.factor });
  return detalle(req);
}

/** Tildar un ingrediente o registrar un cambio (otro insumo, otra cantidad, no había). */
async function editarInsumo(req) {
  const c = await contextoDe(req);
  const id = Number(req.params.id), itemId = Number(req.params.itemId);
  const tv = await cargarTarea(id, c.bizId);
  if (!tv || !staffVe(c, tv)) fallar(404, 'tarea_no_encontrada');
  if (!puedeEjecutar(c, tv)) fallar(403, 'forbidden');
  if (!['en_curso', 'pausada'].includes(tv.estado)) fallar(409, 'no_en_curso', 'Empezá la tarea para marcar los ingredientes');
  const { rows } = await pool.query(`SELECT * FROM produccion_tarea_insumos WHERE id = $1 AND tarea_id = $2`, [itemId, id]);
  const it = rows[0];
  if (!it) fallar(404, 'insumo_no_encontrado');
  const b = req.body || {};
  if ('usado' in b && !b.cambio) {
    await pool.query(`UPDATE produccion_tarea_insumos SET usado = $1 WHERE id = $2`, [!!b.usado, itemId]);
    return detalle(req);
  }
  if (b.deshacer) {
    if (it.cambio && it.cambio !== 'pendiente') fallar(409, 'ya_decidido');
    if (it.agregado) await pool.query(`DELETE FROM produccion_tarea_insumos WHERE id = $1`, [itemId]);
    else await pool.query(`UPDATE produccion_tarea_insumos SET insumo_real_id = NULL, nombre_real = NULL, cantidad_real = NULL, unidad_real = NULL, falta = FALSE, motivo = NULL, cambio = NULL, alcance = 'produccion', proposal_id = NULL WHERE id = $1`, [itemId]);
    await evento(pool, id, c.uid, 'cambio', `Deshizo el cambio en ${it.nombre}`);
    if (it.alcance === 'receta') await proponerReceta(c, tv, req.user?.name || req.user?.email);
    await refrescarCambios(id);
    return detalle(req);
  }
  const k = b.cambio || {};
  const motivo = String(k.motivo || '').trim().slice(0, 300);
  if (!motivo) fallar(400, 'motivo_requerido', 'Contá por qué cambió');
  const alcance = k.alcance === 'receta' && tv.insumo_id ? 'receta' : 'produccion';
  const falta = !!k.falta;
  const cant = falta ? null : num(k.cantidad_real);
  if (!falta && cant == null && !k.insumo_real_id && !k.nombre_real) fallar(400, 'cambio_vacio');
  let nombreReal = k.nombre_real ? String(k.nombre_real).slice(0, 120) : null;
  const insumoReal = Number(k.insumo_real_id) || null;
  if (alcance === 'receta' && !falta && k.nombre_real && !insumoReal) fallar(400, 'elegi_insumo', 'Para cambiar la receta elegí el insumo de la lista');
  if (insumoReal && !nombreReal) {
    const { rows: n } = await pool.query(`SELECT nombre FROM insumos WHERE id = $1`, [insumoReal]);
    nombreReal = n[0]?.nombre || null;
  }
  await pool.query(
    `UPDATE produccion_tarea_insumos SET insumo_real_id = $2, nombre_real = $3, cantidad_real = $4, unidad_real = $5, falta = $6,
       motivo = $7, cambio = 'pendiente', usado = NOT $6, alcance = $8, decidido_por = NULL, decidido_at = NULL, nota_decision = NULL WHERE id = $1`,
    [itemId, insumoReal, nombreReal, cant, k.unidad_real ? String(k.unidad_real).slice(0, 20) : null, falta, motivo, alcance]);
  const texto = falta ? `${alcance === 'receta' ? 'Sacar de la receta' : 'No había'} ${it.nombre}` : `${it.nombre} → ${nombreReal || it.nombre}${cant != null ? ` ${cant}${k.unidad_real ? ` ${k.unidad_real}` : ''}` : ''}`;
  await evento(pool, id, c.uid, 'cambio', `${alcance === 'receta' ? 'Cambio de receta: ' : ''}${texto} · ${motivo}`, { item_id: itemId, alcance });
  if (alcance === 'receta' || it.alcance === 'receta') await proponerReceta(c, tv, req.user?.name || req.user?.email);
  await refrescarCambios(id);
  avisarCambio(c, tv, texto, motivo, alcance);
  return detalle(req);
}

/** Agregar un ingrediente que no estaba en la receta (siempre pasa por aprobación). */
async function agregarInsumo(req) {
  const c = await contextoDe(req);
  const id = Number(req.params.id);
  const tv = await cargarTarea(id, c.bizId);
  if (!tv || !staffVe(c, tv)) fallar(404, 'tarea_no_encontrada');
  if (!puedeEjecutar(c, tv)) fallar(403, 'forbidden');
  if (!['en_curso', 'pausada'].includes(tv.estado)) fallar(409, 'no_en_curso');
  const b = req.body || {};
  let nombre = String(b.nombre || '').trim().slice(0, 120);
  const motivo = String(b.motivo || '').trim().slice(0, 300);
  const cant = num(b.cantidad);
  const alcance = b.alcance === 'receta' && tv.insumo_id ? 'receta' : 'produccion';
  const insumoId = Number(b.insumo_id) || null;
  if (alcance === 'receta' && !insumoId) fallar(400, 'elegi_insumo', 'Para cambiar la receta elegí el insumo de la lista');
  if (insumoId && !nombre) { const { rows: n } = await pool.query(`SELECT nombre FROM insumos WHERE id = $1`, [insumoId]); nombre = n[0]?.nombre || ''; }
  if (!nombre || cant == null || !motivo) fallar(400, 'datos_incompletos', 'Nombre, cantidad y motivo');
  await pool.query(
    `INSERT INTO produccion_tarea_insumos (tarea_id, insumo_id, nombre, cantidad_real, unidad_real, insumo_real_id, nombre_real, agregado, usado, motivo, cambio, alcance, orden)
     VALUES ($1, $2, $3, $4, $5, $2, $3, TRUE, TRUE, $6, 'pendiente', $7, 999)`,
    [id, insumoId, nombre, cant, b.unidad ? String(b.unidad).slice(0, 20) : null, motivo, alcance]);
  const texto = `Agregó ${nombre} ${cant}${b.unidad ? ` ${b.unidad}` : ''}`;
  await evento(pool, id, c.uid, 'cambio', `${alcance === 'receta' ? 'Cambio de receta: ' : ''}${texto} · ${motivo}`, { alcance });
  if (alcance === 'receta') await proponerReceta(c, tv, req.user?.name || req.user?.email);
  await refrescarCambios(id);
  avisarCambio(c, tv, texto, motivo, alcance);
  return detalle(req);
}

async function refrescarCambios(tareaId) {
  await pool.query(
    `UPDATE produccion_tareas t SET cambios = CASE
        WHEN EXISTS (SELECT 1 FROM produccion_tarea_insumos x WHERE x.tarea_id = t.id AND x.cambio = 'pendiente') THEN 'pendiente'
        WHEN EXISTS (SELECT 1 FROM produccion_tarea_insumos x WHERE x.tarea_id = t.id AND x.cambio IS NOT NULL) THEN 'resuelto'
        ELSE NULL END, updated_at = NOW()
      WHERE t.id = $1`, [tareaId]);
}
function avisarCambio(c, t, texto, motivo, alcance = 'produccion') {
  avisarAlEquipoSinEsperar({
    businessId: c.bizId, actorUserId: c.uid, type: 'produccion_cambio',
    title: `${alcance === 'receta' ? 'Cambio de receta' : 'Cambio'} en ${t.titulo}: ${texto}`,
    message: alcance === 'receta' ? `${motivo} · Para aprobar en Aprobaciones` : motivo,
    metadata: { kind: 'produccion_cambio', tarea_id: Number(t.id), fecha: formatoTarea(t).fecha, alcance },
  });
}

/** Dueño/admin: aprobado (vale para esta producción) | rechazado. */
async function decidir(req) {
  const c = await contextoDe(req); exigir(c.decide);
  const id = Number(req.params.id), itemId = Number(req.params.itemId);
  const tv = await cargarTarea(id, c.bizId);
  if (!tv) fallar(404, 'tarea_no_encontrada');
  const decision = String(req.body?.decision || '');
  if (!['aprobado', 'rechazado'].includes(decision)) fallar(400, 'decision_invalida');
  const nota = String(req.body?.nota || '').trim().slice(0, 300) || null;
  const { rows: chk } = await pool.query(`SELECT alcance FROM produccion_tarea_insumos WHERE id = $1 AND tarea_id = $2`, [itemId, id]);
  if (chk[0]?.alcance === 'receta') fallar(409, 'en_aprobaciones', 'Es un cambio de receta: se aprueba o rechaza en Aprobaciones');
  const { rows } = await pool.query(
    `UPDATE produccion_tarea_insumos SET cambio = $3, decidido_por = $4, decidido_at = NOW(), nota_decision = $5
      WHERE id = $1 AND tarea_id = $2 AND cambio = 'pendiente' AND alcance = 'produccion' RETURNING nombre, nombre_real, agregado`,
    [itemId, id, decision, c.uid, nota]);
  if (!rows.length) fallar(409, 'sin_cambio_pendiente');
  const it = rows[0];
  const texto = `${decision === 'aprobado' ? 'Aprobó' : 'Rechazó'} el cambio en ${it.agregado ? it.nombre_real : it.nombre}${nota ? ` · ${nota}` : ''}`;
  await evento(pool, id, c.uid, 'decision', texto, { item_id: itemId, decision });
  await refrescarCambios(id);
  if (tv.responsable_user_id && Number(tv.responsable_user_id) !== c.uid) {
    createSyncNotification({ businessId: c.bizId, userId: Number(tv.responsable_user_id), type: 'produccion_decision',
      title: `${tv.titulo}: ${texto}`, metadata: { kind: 'produccion_decision', tarea_id: id } }).catch(() => {});
  }
  return detalle(req);
}

/** Observación en el hilo de la tarea. Avisa a la otra punta (responsable ↔ quien la programó). */
async function nota(req) {
  const c = await contextoDe(req);
  const id = Number(req.params.id);
  const tv = await cargarTarea(id, c.bizId);
  if (!tv || !staffVe(c, tv)) fallar(404, 'tarea_no_encontrada');
  const texto = String(req.body?.texto || '').trim().slice(0, 1000);
  if (!texto) fallar(400, 'texto_requerido');
  await evento(pool, id, c.uid, 'nota', texto);
  const destinos = new Set([Number(tv.responsable_user_id), Number(tv.creada_por)].filter((x) => x && x !== c.uid));
  for (const uid of destinos) {
    createSyncNotification({ businessId: c.bizId, userId: uid, type: 'produccion_nota', title: `Observación en ${tv.titulo}`,
      message: texto.slice(0, 160), metadata: { kind: 'produccion_nota', tarea_id: id } }).catch(() => {});
  }
  return detalle(req);
}

/** Cambios que esperan decisión (bandeja del dueño/admin). */
async function cambiosPendientes(req) {
  const c = await contextoDe(req); exigir(c.decide);
  await sincronizarPropuestas(c.bizId);
  const { rows } = await pool.query(
    `SELECT x.*, t.titulo, t.fecha, t.tandas, t.id AS tarea_id,
            COALESCE(NULLIF(u.display_name, ''), NULLIF(u.name, ''), split_part(u.email, '@', 1)) AS responsable
       FROM produccion_tarea_insumos x JOIN produccion_tareas t ON t.id = x.tarea_id
       LEFT JOIN app_users u ON u.id = t.responsable_user_id
      WHERE t.business_id = $1 AND t.branch_id IS NOT DISTINCT FROM $2::bigint AND t.deleted_at IS NULL AND x.cambio = 'pendiente'
      ORDER BY t.fecha DESC, x.id`, [c.bizId, c.suc]);
  return rows.map((r) => ({ ...formatoInsumo(r), tarea_id: Number(r.tarea_id), titulo: r.titulo,
    fecha: String(r.fecha instanceof Date ? r.fecha.toISOString() : r.fecha).slice(0, 10), tandas: num(r.tandas), responsable: r.responsable }));
}

/** Panel general: quién hizo qué y en cuánto tiempo (estimado vs real), por persona y por elaborado. */
async function panel(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const desde = fechaISO(req.query.desde) || lunesDe(new Date().toISOString().slice(0, 10));
  const hasta = fechaISO(req.query.hasta) || sumarDias(desde, 6);
  const { rows } = await pool.query(`${SELECT_TAREA} WHERE t.business_id = $1 AND t.branch_id IS NOT DISTINCT FROM $4::bigint AND t.deleted_at IS NULL AND t.fecha BETWEEN $2 AND $3`, [c.bizId, desde, hasta, c.suc]);
  const ahora = new Date();
  const tareas = rows.map((t) => formatoTarea(t, ahora));
  return { desde, hasta, ...resumirPanel(tareas) };
}
/** Puro: agrupa por persona y por elaborado. Minutos reales solo de tareas hechas. */
function resumirPanel(tareas) {
  const vacio = () => ({ tareas: 0, hechas: 0, pendientes: 0, en_curso: 0, canceladas: 0, minutos_estimados: 0, minutos_reales: 0, estimado_de_hechas: 0, cambios: 0 });
  const sumar = (acc, t) => {
    acc.tareas += 1;
    if (t.estado === 'hecha') { acc.hechas += 1; acc.minutos_reales += t.segundos / 60; acc.estimado_de_hechas += t.minutos_estimados || 0; }
    else if (t.estado === 'cancelada') acc.canceladas += 1;
    else if (t.estado === 'pendiente') acc.pendientes += 1;
    else acc.en_curso += 1;
    if (t.estado !== 'cancelada') acc.minutos_estimados += t.minutos_estimados || 0;
    if (t.cambios) acc.cambios += 1;
    return acc;
  };
  const personas = new Map(), elab = new Map();
  const total = vacio();
  for (const t of tareas) {
    sumar(total, t);
    const kp = t.responsable_user_id || 0;
    if (!personas.has(kp)) personas.set(kp, { user_id: t.responsable_user_id, nombre: t.responsable || 'Sin responsable', ...vacio() });
    sumar(personas.get(kp), t);
    const ke = t.insumo_id ? `i${t.insumo_id}` : `t${t.titulo}`;
    if (!elab.has(ke)) elab.set(ke, { insumo_id: t.insumo_id, titulo: t.titulo, unidad: t.unidad, tandas: 0, rinde_esperado: 0, rinde_real: 0, ...vacio() });
    const e = sumar(elab.get(ke), t);
    if (t.estado === 'hecha') { e.tandas += t.tandas || 0; e.rinde_esperado += t.rinde_esperado || 0; e.rinde_real += t.rinde_real || 0; }
  }
  const fin = (x) => ({ ...x, minutos_reales: Math.round(x.minutos_reales), minutos_estimados: Math.round(x.minutos_estimados), estimado_de_hechas: Math.round(x.estimado_de_hechas) });
  return {
    total: fin(total),
    personas: [...personas.values()].map(fin).sort((a, b) => b.hechas - a.hechas || a.nombre.localeCompare(b.nombre, 'es')),
    elaborados: [...elab.values()].map(fin).sort((a, b) => b.tareas - a.tareas),
  };
}

module.exports = {
  ErrorProduccion, contexto, asignarAreas, escalar, guardarTurno, borrarTurno, elaborados, guardarElaborado,
  listarTareas, crearTareas, editarTarea, borrarTarea, copiarSemana, detalle, accion,
  editarInsumo, agregarInsumo, decidir, nota, cambiosPendientes, panel, buscarInsumos,
  _ctx: { contextoDe, fallar, exigir, fechaISO, sumarDias, lunesDe, bizInsumos },
  // puros (tests)
  _puros: { cuerpoPropuesta, loteDe, escalarPorIngrediente, fechaISO, sumarDias, lunesDe, tandasValidas, segundosHasta, escalarItems, copiarTareas, resumirPanel },
};
