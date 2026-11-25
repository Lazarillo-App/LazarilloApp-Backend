// services/mantenimiento.js — Operación › Mantenimiento (usuaria 21/11/2026, etapa 3 de Producción).
// Ver db/migrations/live/164_mantenimiento.sql.
//
// Quién hace qué (mismas reglas que Producción):
//   · Equipos y planes preventivos: jefe de cocina / dueño / admin.
//   · Hacer una orden: su responsable, cualquiera si no tiene, o jefe / dueño / admin.
//   · Reportar una falla y cargar registros (aceite, limpieza, temperatura): cualquiera del equipo.
//   · Precio del equipo y costo de las órdenes: solo dueño / admin (el staff no ve plata).
// Las órdenes preventivas se generan solas cuando falta una semana o menos para la fecha del plan.
'use strict';

const pool = require('../config/db');
const { _ctx, contexto: contextoProduccion } = require('./produccion');
const { sqlEsJefe } = require('./auth/permisos');
const { avisarAbm, avisarAlEquipoSinEsperar, createSyncNotification } = require('./notificationService');

const { contextoDe, fallar, exigir, fechaISO, sumarDias } = _ctx;
const num = (v) => { if (v === '' || v == null) return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const texto = (v, max = 200) => { const s = String(v ?? '').trim().slice(0, max); return s || null; };
const isoDe = (d) => (d instanceof Date ? d.toISOString() : String(d ?? '')).slice(0, 10) || null;
const hoyAR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const nombreUsuario = (a) => `COALESCE(NULLIF(${a}.display_name, ''), NULLIF(${a}.name, ''), split_part(${a}.email, '@', 1))`;

const RUBROS = ['heladera', 'freidora', 'horno', 'maquina', 'otro'];
const UNIDADES = ['dias', 'semanas', 'meses'];
const TIPOS_REGISTRO = {
  aceite_filtrado: 'Filtrado de aceite', aceite_cambio: 'Cambio de aceite', aceite_carga: 'Carga de aceite',
  limpieza: 'Limpieza', temperatura: 'Temperatura', otro: 'Otro',
};

// ── Puros (tests en mantenimiento.test.js) ───────────────────────────────────────────────────
/** Próxima fecha: desde + N unidades y, si hay días permitidos, el primero que caiga en uno. */
function siguienteFecha(desde, cadaN, unidad, diasSemana) {
  const n = Math.max(1, Number(cadaN) || 1);
  const d = new Date(`${desde}T12:00:00Z`);
  if (unidad === 'dias') d.setUTCDate(d.getUTCDate() + n);
  else if (unidad === 'semanas') d.setUTCDate(d.getUTCDate() + 7 * n);
  else {
    const dia = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
    const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(dia, ultimo)); // 31/01 + 1 mes = 28/02
  }
  return ajustarDia(d.toISOString().slice(0, 10), diasSemana);
}
/** Corre la fecha hacia adelante hasta un día permitido (0 = domingo … 6 = sábado). */
function ajustarDia(iso, diasSemana) {
  const ok = Array.isArray(diasSemana) ? diasSemana.map(Number).filter((x) => x >= 0 && x <= 6) : [];
  if (!ok.length || ok.length === 7) return iso;
  let f = iso;
  for (let i = 0; i < 7; i++) {
    if (ok.includes(new Date(`${f}T12:00:00Z`).getUTCDay())) return f;
    f = sumarDias(f, 1);
  }
  return iso;
}
const textoFrecuencia = (n, u) => (Number(n) === 1 ? { dias: 'Todos los días', semanas: 'Cada semana', meses: 'Cada mes' }[u] : `Cada ${n} ${u}`);

// ── Contexto ─────────────────────────────────────────────────────────────────────────────────
async function contexto(req) {
  const base = await contextoProduccion(req);
  return { ...base, rubros: RUBROS, tipos_registro: TIPOS_REGISTRO, gestor: req.businessRole === 'owner' || req.businessRole === 'admin' };
}

/** Las órdenes preventivas de los planes que vencen en los próximos 7 días (si no hay una abierta). */
async function generarOrdenes(bizId) {
  await pool.query(
    `INSERT INTO mant_ordenes (business_id, equipo_id, plan_id, tipo, titulo, descripcion, fecha, responsable_user_id)
     SELECT p.business_id, p.equipo_id, p.id, 'preventivo', p.nombre, p.descripcion, p.proxima, COALESCE(p.responsable_user_id, e.responsable_user_id)
       FROM mant_planes p JOIN mant_equipos e ON e.id = p.equipo_id AND e.deleted_at IS NULL AND e.estado <> 'baja'
      WHERE p.business_id = $1 AND p.activo AND p.deleted_at IS NULL AND p.proxima <= $2::date + 7
        AND NOT EXISTS (SELECT 1 FROM mant_ordenes o WHERE o.plan_id = p.id AND o.estado = 'pendiente')
        AND NOT EXISTS (SELECT 1 FROM mant_ordenes o WHERE o.plan_id = p.id AND o.fecha = p.proxima)`, [bizId, hoyAR()]);
}

// ── Equipos ──────────────────────────────────────────────────────────────────────────────────
async function listarEquipos(req) {
  const c = await contextoDe(req);
  await generarOrdenes(c.bizId);
  const { rows } = await pool.query(
    `SELECT e.*, s.nombre AS sector, ${nombreUsuario('u')} AS responsable,
            (SELECT COUNT(*) FROM mant_ordenes o WHERE o.equipo_id = e.id AND o.estado = 'pendiente')::int AS abiertas,
            (SELECT COUNT(*) FROM mant_ordenes o WHERE o.equipo_id = e.id AND o.estado = 'pendiente' AND o.tipo = 'correctivo')::int AS fallas,
            (SELECT MIN(o.fecha) FROM mant_ordenes o WHERE o.equipo_id = e.id AND o.estado = 'pendiente') AS proxima,
            (SELECT MAX(o.hecha_at) FROM mant_ordenes o WHERE o.equipo_id = e.id AND o.estado = 'hecha') AS ultima,
            (SELECT COUNT(*) FROM mant_planes p WHERE p.equipo_id = e.id AND p.deleted_at IS NULL AND p.activo)::int AS planes
       FROM mant_equipos e LEFT JOIN sectores s ON s.id = e.sector_id LEFT JOIN app_users u ON u.id = e.responsable_user_id
      WHERE e.business_id = $1 AND e.branch_id IS NOT DISTINCT FROM $2::bigint AND e.deleted_at IS NULL
      ORDER BY (e.estado = 'baja'), e.rubro, e.nombre`, [c.bizId, c.suc]);
  return { equipos: rows.map((r) => formatoEquipo(r, c)) };
}
function formatoEquipo(r, c) {
  return {
    id: Number(r.id), nombre: r.nombre, rubro: r.rubro, marca: r.marca, modelo: r.modelo, proveedor: r.proveedor, codigo: r.codigo,
    ubicacion: r.ubicacion, sector_id: r.sector_id, sector: r.sector, responsable_user_id: r.responsable_user_id ? Number(r.responsable_user_id) : null,
    responsable: r.responsable, fecha_compra: isoDe(r.fecha_compra), fecha_instalacion: isoDe(r.fecha_instalacion),
    precio: c.gestor ? num(r.precio) : undefined, estado: r.estado, fecha_baja: isoDe(r.fecha_baja), notas: r.notas,
    abiertas: r.abiertas ?? 0, fallas: r.fallas ?? 0, proxima: isoDe(r.proxima), ultima: r.ultima || null, planes: r.planes ?? 0,
  };
}

async function guardarEquipo(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const b = req.body || {};
  const nombre = texto(b.nombre, 100);
  if (!nombre) fallar(400, 'nombre_requerido', 'Poné el nombre del equipo');
  const rubro = RUBROS.includes(b.rubro) ? b.rubro : 'otro';
  const estado = ['activo', 'en_reparacion', 'baja'].includes(b.estado) ? b.estado : 'activo';
  const vals = [nombre, rubro, texto(b.marca, 60), texto(b.modelo, 60), texto(b.proveedor, 80), texto(b.codigo, 30), texto(b.ubicacion, 80),
    Number(b.sector_id) || null, Number(b.responsable_user_id) || null, fechaISO(b.fecha_compra), fechaISO(b.fecha_instalacion),
    estado, estado === 'baja' ? (fechaISO(b.fecha_baja) || hoyAR()) : null, texto(b.notas, 1000)];
  const id = Number(req.params.equipoId) || null;
  let equipoId = id;
  if (id) {
    const { rowCount } = await pool.query(
      `UPDATE mant_equipos SET nombre = $1, rubro = $2, marca = $3, modelo = $4, proveedor = $5, codigo = $6, ubicacion = $7, sector_id = $8,
         responsable_user_id = $9, fecha_compra = $10, fecha_instalacion = $11, estado = $12, fecha_baja = $13, notas = $14,
         precio = CASE WHEN $15::boolean THEN $16 ELSE precio END, updated_at = NOW()
        WHERE id = $17 AND business_id = $18 AND deleted_at IS NULL`, [...vals, c.gestor, num(b.precio), id, c.bizId]);
    if (!rowCount) fallar(404, 'equipo_no_encontrado');
    const titulo = estado === 'baja' ? `Equipo de baja: ${nombre}` : `Equipo editado: ${nombre}`;
    avisarAbm(req, { businessId: c.bizId, type: 'mant_equipo', title: titulo, metadata: { equipo_id: id, estado } });
  } else {
    const { rows } = await pool.query(
      `INSERT INTO mant_equipos (nombre, rubro, marca, modelo, proveedor, codigo, ubicacion, sector_id, responsable_user_id, fecha_compra,
         fecha_instalacion, estado, fecha_baja, notas, precio, business_id, created_by, branch_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::bigint) RETURNING id`,
      [...vals, c.gestor ? num(b.precio) : null, c.bizId, c.uid, c.suc]);
    equipoId = Number(rows[0].id);
    avisarAbm(req, { businessId: c.bizId, type: 'mant_equipo', title: `Equipo nuevo: ${nombre}`, metadata: { equipo_id: equipoId, rubro } });
  }
  return detalleEquipo({ ...req, params: { ...req.params, equipoId } });
}

async function borrarEquipo(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const equipoId = Number(req.params.equipoId);
  const { rows: eq } = await pool.query(
    `UPDATE mant_equipos SET deleted_at = NOW() WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL RETURNING nombre`,
    [equipoId, c.bizId]);
  await pool.query(`UPDATE mant_ordenes SET estado = 'cancelada', updated_at = NOW() WHERE equipo_id = $1 AND estado = 'pendiente'`, [equipoId]);
  if (eq[0]?.nombre) {
    avisarAbm(req, { businessId: c.bizId, type: 'mant_equipo', title: `Equipo de baja: ${eq[0].nombre}`, metadata: { equipo_id: equipoId } });
  }
  return { ok: true };
}

async function detalleEquipo(req) {
  const c = await contextoDe(req);
  const id = Number(req.params.equipoId);
  await generarOrdenes(c.bizId);
  const { rows } = await pool.query(
    `SELECT e.*, s.nombre AS sector, ${nombreUsuario('u')} AS responsable
       FROM mant_equipos e LEFT JOIN sectores s ON s.id = e.sector_id LEFT JOIN app_users u ON u.id = e.responsable_user_id
      WHERE e.id = $1 AND e.business_id = $2 AND e.deleted_at IS NULL`, [id, c.bizId]);
  if (!rows.length) fallar(404, 'equipo_no_encontrado');
  const { rows: planes } = await pool.query(
    `SELECT p.*, ${nombreUsuario('u')} AS responsable FROM mant_planes p LEFT JOIN app_users u ON u.id = p.responsable_user_id
      WHERE p.equipo_id = $1 AND p.deleted_at IS NULL ORDER BY p.activo DESC, p.proxima`, [id]);
  const { rows: ordenes } = await pool.query(`${SELECT_ORDEN} WHERE o.equipo_id = $1 ORDER BY (o.estado = 'pendiente') DESC, COALESCE(o.hecha_at, o.fecha::timestamptz) DESC LIMIT 60`, [id]);
  const { rows: registros } = await pool.query(
    `SELECT r.*, ${nombreUsuario('u')} AS usuario FROM mant_registros r LEFT JOIN app_users u ON u.id = r.user_id
      WHERE r.equipo_id = $1 AND r.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT 60`, [id]);
  return {
    equipo: formatoEquipo(rows[0], c),
    planes: planes.map((p) => ({
      id: Number(p.id), nombre: p.nombre, descripcion: p.descripcion, cada_n: p.cada_n, unidad: p.unidad, frecuencia: textoFrecuencia(p.cada_n, p.unidad),
      dias_semana: p.dias_semana, responsable_user_id: p.responsable_user_id ? Number(p.responsable_user_id) : null, responsable: p.responsable,
      nota_obligatoria: p.nota_obligatoria, activo: p.activo, ultima: isoDe(p.ultima), proxima: isoDe(p.proxima),
    })),
    ordenes: ordenes.map((o) => formatoOrden(o, c)),
    registros: registros.map(formatoRegistro),
  };
}

// ── Planes preventivos ───────────────────────────────────────────────────────────────────────
async function guardarPlan(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const b = req.body || {};
  const equipoId = Number(req.params.equipoId);
  const { rows: eq } = await pool.query(`SELECT id, nombre FROM mant_equipos WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`, [equipoId, c.bizId]);
  if (!eq.length) fallar(404, 'equipo_no_encontrado');
  const nombre = texto(b.nombre, 100);
  if (!nombre) fallar(400, 'nombre_requerido', 'Poné qué mantenimiento es');
  const cadaN = Math.max(1, Math.min(365, Math.round(num(b.cada_n) || 1)));
  const unidad = UNIDADES.includes(b.unidad) ? b.unidad : 'meses';
  const dias = Array.isArray(b.dias_semana) && b.dias_semana.length && b.dias_semana.length < 7
    ? [...new Set(b.dias_semana.map(Number).filter((x) => x >= 0 && x <= 6))] : null;
  const proxima = ajustarDia(fechaISO(b.proxima) || hoyAR(), dias);
  const vals = [nombre, texto(b.descripcion, 1000), cadaN, unidad, dias, Number(b.responsable_user_id) || null, !!b.nota_obligatoria, b.activo !== false, proxima];
  const planId = Number(req.params.planId) || null;
  const equipoNombre = eq[0].nombre;
  if (planId) {
    const { rowCount } = await pool.query(
      `UPDATE mant_planes SET nombre = $1, descripcion = $2, cada_n = $3, unidad = $4, dias_semana = $5::smallint[], responsable_user_id = $6,
         nota_obligatoria = $7, activo = $8, proxima = $9 WHERE id = $10 AND equipo_id = $11 AND deleted_at IS NULL`, [...vals, planId, equipoId]);
    if (!rowCount) fallar(404, 'plan_no_encontrado');
    // La orden abierta del plan sigue la nueva fecha / responsable.
    await pool.query(
      `UPDATE mant_ordenes SET fecha = $2, titulo = $3, responsable_user_id = COALESCE($4, responsable_user_id), updated_at = NOW()
        WHERE plan_id = $1 AND estado = 'pendiente'`, [planId, proxima, nombre, Number(b.responsable_user_id) || null]);
    if (b.activo === false) await pool.query(`UPDATE mant_ordenes SET estado = 'cancelada', updated_at = NOW() WHERE plan_id = $1 AND estado = 'pendiente'`, [planId]);
    avisarAbm(req, { businessId: c.bizId, type: 'mant_plan', title: `Mantenimiento editado: ${nombre} · ${equipoNombre}`, metadata: { equipo_id: equipoId, plan_id: planId } });
  } else {
    const { rows: ins } = await pool.query(
      `INSERT INTO mant_planes (nombre, descripcion, cada_n, unidad, dias_semana, responsable_user_id, nota_obligatoria, activo, proxima, business_id, equipo_id, created_by)
       VALUES ($1,$2,$3,$4,$5::smallint[],$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [...vals, c.bizId, equipoId, c.uid]);
    avisarAbm(req, { businessId: c.bizId, type: 'mant_plan', title: `Mantenimiento nuevo: ${nombre} · ${equipoNombre}`, metadata: { equipo_id: equipoId, plan_id: Number(ins[0]?.id) || null } });
  }
  return detalleEquipo(req);
}
async function borrarPlan(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const planId = Number(req.params.planId);
  const { rows: pl } = await pool.query(
    `UPDATE mant_planes p SET deleted_at = NOW()
       FROM mant_equipos e
      WHERE p.id = $1 AND p.business_id = $2 AND p.deleted_at IS NULL AND e.id = p.equipo_id
      RETURNING p.nombre, p.equipo_id, e.nombre AS equipo`,
    [planId, c.bizId]);
  await pool.query(`UPDATE mant_ordenes SET estado = 'cancelada', updated_at = NOW() WHERE plan_id = $1 AND estado = 'pendiente'`, [planId]);
  if (pl[0]?.nombre) {
    avisarAbm(req, { businessId: c.bizId, type: 'mant_plan', title: `Mantenimiento eliminado: ${pl[0].nombre}${pl[0].equipo ? ` · ${pl[0].equipo}` : ''}`, metadata: { equipo_id: Number(pl[0].equipo_id) || null, plan_id: planId } });
  }
  return detalleEquipo(req);
}

// ── Órdenes ──────────────────────────────────────────────────────────────────────────────────
const SELECT_ORDEN = `
  SELECT o.*, e.nombre AS equipo, e.rubro, e.ubicacion, p.nota_obligatoria, p.cada_n, p.unidad AS plan_unidad,
         ${nombreUsuario('u')} AS responsable, ${nombreUsuario('ur')} AS reporto, ${nombreUsuario('uh')} AS hizo
    FROM mant_ordenes o JOIN mant_equipos e ON e.id = o.equipo_id
    LEFT JOIN mant_planes p ON p.id = o.plan_id
    LEFT JOIN app_users u ON u.id = o.responsable_user_id
    LEFT JOIN app_users ur ON ur.id = o.reportada_por
    LEFT JOIN app_users uh ON uh.id = o.hecha_por`;
function formatoOrden(o, c) {
  return {
    id: Number(o.id), equipo_id: Number(o.equipo_id), equipo: o.equipo, rubro: o.rubro, ubicacion: o.ubicacion, plan_id: o.plan_id ? Number(o.plan_id) : null,
    tipo: o.tipo, titulo: o.titulo, descripcion: o.descripcion, fecha: isoDe(o.fecha), urgente: o.urgente, estado: o.estado,
    responsable_user_id: o.responsable_user_id ? Number(o.responsable_user_id) : null, responsable: o.responsable,
    reporto: o.reporto, hizo: o.hizo, hecha_at: o.hecha_at, nota: o.nota, nota_obligatoria: !!o.nota_obligatoria,
    frecuencia: o.plan_id ? textoFrecuencia(o.cada_n, o.plan_unidad) : null,
    costo: c.gestor ? num(o.costo) : undefined, proveedor: o.proveedor,
    puede_hacer: c.planifica || !o.responsable_user_id || Number(o.responsable_user_id) === c.uid,
  };
}

async function listarOrdenes(req) {
  const c = await contextoDe(req);
  await generarOrdenes(c.bizId);
  const hasta = fechaISO(req.query.hasta) || sumarDias(hoyAR(), 14);
  // Abiertas hasta `hasta` (incluye vencidas) + las hechas de los últimos 14 días.
  const { rows } = await pool.query(
    `${SELECT_ORDEN}
      WHERE o.business_id = $1 AND e.branch_id IS NOT DISTINCT FROM $5::bigint AND e.deleted_at IS NULL
        AND ((o.estado = 'pendiente' AND o.fecha <= $2) OR (o.estado = 'hecha' AND o.hecha_at > NOW() - INTERVAL '14 days'))
        AND ($3::boolean OR o.responsable_user_id = $4 OR o.responsable_user_id IS NULL OR o.reportada_por = $4)
      ORDER BY (o.estado = 'pendiente') DESC, o.urgente DESC, o.fecha, o.id`, [c.bizId, hasta, c.planifica, c.uid, c.suc]);
  return { hoy: hoyAR(), ordenes: rows.map((o) => formatoOrden(o, c)) };
}

/** Falla reportada por cualquiera del equipo → orden correctiva + aviso a jefes / dueño / admin. */
async function reportarFalla(req) {
  const c = await contextoDe(req);
  const b = req.body || {};
  const equipoId = Number(b.equipo_id);
  const { rows: eq } = await pool.query(`SELECT * FROM mant_equipos WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`, [equipoId, c.bizId]);
  if (!eq.length) fallar(404, 'equipo_no_encontrado');
  const que = texto(b.titulo, 140);
  if (!que) fallar(400, 'titulo_requerido', 'Contá qué le pasa');
  const { rows } = await pool.query(
    `INSERT INTO mant_ordenes (business_id, equipo_id, tipo, titulo, descripcion, fecha, responsable_user_id, urgente, reportada_por)
     VALUES ($1, $2, 'correctivo', $3, $4, $5, $6, $7, $8) RETURNING id`,
    [c.bizId, equipoId, que, texto(b.descripcion, 1000), hoyAR(), eq[0].responsable_user_id, !!b.urgente, c.uid]);
  if (b.no_funciona) await pool.query(`UPDATE mant_equipos SET estado = 'en_reparacion', updated_at = NOW() WHERE id = $1`, [equipoId]);
  const id = Number(rows[0].id);
  const title = `${b.urgente ? '🔴 Urgente · ' : ''}Falla en ${eq[0].nombre}: ${que}`;
  avisarAlEquipoSinEsperar({ businessId: c.bizId, actorUserId: c.uid, type: 'mant_falla', title, message: b.no_funciona ? 'No funciona' : null, metadata: { kind: 'mant_falla', orden_id: id } });
  const { rows: jefes } = await pool.query(
    `SELECT DISTINCT ua.user_id FROM user_assignments ua WHERE ua.scope_type = 'business' AND ua.scope_id = $1 AND ua.revoked_at IS NULL AND ${sqlEsJefe('ua')}`, [c.bizId]);
  for (const j of jefes) {
    if (Number(j.user_id) === c.uid) continue;
    createSyncNotification({ businessId: c.bizId, userId: Number(j.user_id), type: 'mant_falla', title, metadata: { kind: 'mant_falla', orden_id: id } }).catch(() => {});
  }
  return { id };
}

async function crearOrden(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const b = req.body || {};
  const { rows: eq } = await pool.query(`SELECT id FROM mant_equipos WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`, [Number(b.equipo_id), c.bizId]);
  if (!eq.length) fallar(404, 'equipo_no_encontrado');
  const titulo = texto(b.titulo, 140);
  if (!titulo) fallar(400, 'titulo_requerido');
  const resp = Number(b.responsable_user_id) || null;
  const { rows } = await pool.query(
    `INSERT INTO mant_ordenes (business_id, equipo_id, tipo, titulo, descripcion, fecha, responsable_user_id, urgente, reportada_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [c.bizId, Number(b.equipo_id), b.tipo === 'correctivo' ? 'correctivo' : 'preventivo', titulo, texto(b.descripcion, 1000),
      fechaISO(b.fecha) || hoyAR(), resp, !!b.urgente, c.uid]);
  if (resp && resp !== c.uid) avisarAsignada(c, resp, titulo, Number(rows[0].id));
  return { id: Number(rows[0].id) };
}
function avisarAsignada(c, uid, titulo, id) {
  createSyncNotification({ businessId: c.bizId, userId: uid, type: 'mant_orden', title: `Mantenimiento para vos: ${titulo}`, metadata: { kind: 'mant_orden', orden_id: id } }).catch(() => {});
}

/** hacer | reprogramar | asignar | cancelar | reabrir */
async function accionOrden(req) {
  const c = await contextoDe(req);
  const id = Number(req.params.ordenId);
  const que = String(req.params.accion);
  const b = req.body || {};
  const { rows } = await pool.query(`${SELECT_ORDEN} WHERE o.id = $1 AND o.business_id = $2`, [id, c.bizId]);
  const o = rows[0];
  if (!o) fallar(404, 'orden_no_encontrada');
  const puedeHacer = c.planifica || !o.responsable_user_id || Number(o.responsable_user_id) === c.uid;
  if (que === 'hacer') {
    if (!puedeHacer) fallar(403, 'forbidden');
    if (o.estado !== 'pendiente') fallar(409, 'estado_invalido');
    const nota = texto(b.nota, 1000);
    if (o.nota_obligatoria && !nota) fallar(400, 'nota_requerida', 'Este mantenimiento pide una nota');
    await pool.query(
      `UPDATE mant_ordenes SET estado = 'hecha', hecha_por = $2, hecha_at = NOW(), nota = $3,
         costo = CASE WHEN $4::boolean THEN $5 ELSE costo END, proveedor = COALESCE($6, proveedor), updated_at = NOW() WHERE id = $1`,
      [id, c.uid, nota, c.gestor, num(b.costo), texto(b.proveedor, 80)]);
    if (o.plan_id) {
      const { rows: p } = await pool.query(`SELECT * FROM mant_planes WHERE id = $1`, [o.plan_id]);
      if (p[0]) {
        const hecha = hoyAR();
        await pool.query(`UPDATE mant_planes SET ultima = $2, proxima = $3 WHERE id = $1`,
          [o.plan_id, hecha, siguienteFecha(hecha, p[0].cada_n, p[0].unidad, p[0].dias_semana)]);
      }
    }
    // Arreglada la falla: el equipo vuelve a andar si no queda otra correctiva abierta.
    if (o.tipo === 'correctivo') {
      await pool.query(
        `UPDATE mant_equipos e SET estado = 'activo', updated_at = NOW() WHERE e.id = $1 AND e.estado = 'en_reparacion'
           AND NOT EXISTS (SELECT 1 FROM mant_ordenes x WHERE x.equipo_id = e.id AND x.tipo = 'correctivo' AND x.estado = 'pendiente')`, [o.equipo_id]);
      if (o.reportada_por && Number(o.reportada_por) !== c.uid) {
        createSyncNotification({ businessId: c.bizId, userId: Number(o.reportada_por), type: 'mant_orden', title: `Arreglado: ${o.equipo} · ${o.titulo}`,
          message: nota, metadata: { kind: 'mant_orden', orden_id: id } }).catch(() => {});
      }
    }
  } else if (que === 'reprogramar') {
    if (!puedeHacer) fallar(403, 'forbidden');
    const f = fechaISO(b.fecha);
    if (!f) fallar(400, 'fecha_invalida');
    await pool.query(`UPDATE mant_ordenes SET fecha = $2, updated_at = NOW() WHERE id = $1 AND estado = 'pendiente'`, [id, f]);
    if (o.plan_id) await pool.query(`UPDATE mant_planes SET proxima = $2 WHERE id = $1`, [o.plan_id, f]);
  } else if (que === 'asignar') {
    exigir(c.planifica);
    const r = Number(b.responsable_user_id) || null;
    await pool.query(`UPDATE mant_ordenes SET responsable_user_id = $2, updated_at = NOW() WHERE id = $1`, [id, r]);
    if (r && r !== c.uid && r !== Number(o.responsable_user_id)) avisarAsignada(c, r, `${o.equipo} · ${o.titulo}`, id);
  } else if (que === 'cancelar') {
    exigir(c.planifica);
    if (o.estado !== 'pendiente') fallar(409, 'estado_invalido');
    await pool.query(`UPDATE mant_ordenes SET estado = 'cancelada', nota = COALESCE($2, nota), updated_at = NOW() WHERE id = $1`, [id, texto(b.nota, 500)]);
    // Saltear una preventiva: el plan pasa a la siguiente fecha.
    if (o.plan_id) {
      const { rows: p } = await pool.query(`SELECT * FROM mant_planes WHERE id = $1`, [o.plan_id]);
      if (p[0]) await pool.query(`UPDATE mant_planes SET proxima = $2 WHERE id = $1`, [o.plan_id, siguienteFecha(isoDe(o.fecha), p[0].cada_n, p[0].unidad, p[0].dias_semana)]);
    }
  } else if (que === 'reabrir') {
    exigir(c.planifica);
    if (o.estado === 'pendiente') fallar(409, 'estado_invalido');
    await pool.query(`UPDATE mant_ordenes SET estado = 'pendiente', hecha_por = NULL, hecha_at = NULL, updated_at = NOW() WHERE id = $1`, [id]);
  } else fallar(400, 'accion_invalida');
  const { rows: nuevo } = await pool.query(`${SELECT_ORDEN} WHERE o.id = $1`, [id]);
  return { orden: formatoOrden(nuevo[0], c) };
}

// ── Registros rápidos ────────────────────────────────────────────────────────────────────────
function formatoRegistro(r) {
  return { id: Number(r.id), equipo_id: Number(r.equipo_id), equipo: r.equipo, tipo: r.tipo, tipo_label: TIPOS_REGISTRO[r.tipo] || r.tipo,
    valor: num(r.valor), unidad: r.unidad, nota: r.nota, usuario: r.usuario, user_id: r.user_id ? Number(r.user_id) : null, created_at: r.created_at };
}
async function listarRegistros(req) {
  const c = await contextoDe(req);
  const { rows } = await pool.query(
    `SELECT r.*, e.nombre AS equipo, ${nombreUsuario('u')} AS usuario
       FROM mant_registros r JOIN mant_equipos e ON e.id = r.equipo_id LEFT JOIN app_users u ON u.id = r.user_id
      WHERE r.business_id = $1 AND e.branch_id IS NOT DISTINCT FROM $2::bigint AND r.deleted_at IS NULL AND r.created_at > NOW() - INTERVAL '30 days'
      ORDER BY r.created_at DESC LIMIT 200`, [c.bizId, c.suc]);
  return { registros: rows.map(formatoRegistro) };
}
async function crearRegistro(req) {
  const c = await contextoDe(req);
  const b = req.body || {};
  const { rows: eq } = await pool.query(`SELECT id FROM mant_equipos WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`, [Number(b.equipo_id), c.bizId]);
  if (!eq.length) fallar(404, 'equipo_no_encontrado');
  const tipo = TIPOS_REGISTRO[b.tipo] ? b.tipo : null;
  if (!tipo) fallar(400, 'tipo_invalido');
  const valor = num(b.valor);
  if ((tipo === 'temperatura' || tipo.startsWith('aceite_')) && valor == null) fallar(400, 'valor_requerido', tipo === 'temperatura' ? 'Poné la temperatura' : 'Poné los litros');
  const unidad = tipo === 'temperatura' ? '°C' : tipo.startsWith('aceite_') ? 'L' : null;
  await pool.query(`INSERT INTO mant_registros (business_id, equipo_id, tipo, valor, unidad, nota, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [c.bizId, Number(b.equipo_id), tipo, valor, unidad, texto(b.nota, 300), c.uid]);
  return listarRegistros(req);
}
async function borrarRegistro(req) {
  const c = await contextoDe(req);
  const { rowCount } = await pool.query(
    `UPDATE mant_registros SET deleted_at = NOW() WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL
        AND ($3::boolean OR (user_id = $4 AND created_at > NOW() - INTERVAL '24 hours'))`, [Number(req.params.registroId), c.bizId, c.planifica, c.uid]);
  if (!rowCount) fallar(403, 'forbidden', 'Solo lo borra quien lo cargó (en el día) o el jefe');
  return listarRegistros(req);
}

module.exports = {
  contexto, listarEquipos, guardarEquipo, borrarEquipo, detalleEquipo, guardarPlan, borrarPlan,
  listarOrdenes, reportarFalla, crearOrden, accionOrden, listarRegistros, crearRegistro, borrarRegistro,
  _puros: { siguienteFecha, ajustarDia, textoFrecuencia },
};
