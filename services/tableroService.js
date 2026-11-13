// services/tableroService.js
// Tablero de tareas del equipo (panel de super usuarios, usuaria 13/11/2026): pendientes que se
// anotan Mairene y Diego, con estado, prioridad, a quién le toca y un hilo de notas.
'use strict';

const pool = require('../config/db');
const actividad = require('./superActividadService');

const ESTADOS = ['pendiente', 'en_curso', 'hecha'];
const PRIORIDADES = ['alta', 'normal', 'baja'];

const corto = (s, max) => String(s ?? '').trim().slice(0, max);

/** Valida y normaliza los campos editables. Devuelve { campos } o { error }. */
function validarCambios(c = {}, { nueva = false } = {}) {
  const campos = {};
  if (nueva || c.titulo !== undefined) {
    const t = corto(c.titulo, 200);
    if (!t) return { error: 'titulo_vacio' };
    campos.titulo = t;
  }
  if (c.detalle !== undefined) campos.detalle = corto(c.detalle, 8000) || null;
  if (c.estado !== undefined) {
    if (!ESTADOS.includes(c.estado)) return { error: 'estado_invalido' };
    campos.estado = c.estado;
  }
  if (c.prioridad !== undefined) {
    if (!PRIORIDADES.includes(c.prioridad)) return { error: 'prioridad_invalida' };
    campos.prioridad = c.prioridad;
  }
  if (c.asignado_a !== undefined) {
    const n = Number(c.asignado_a);
    if (c.asignado_a === null || c.asignado_a === '' || c.asignado_a === 0) campos.asignado_a = null;
    else if (Number.isInteger(n) && n > 0) campos.asignado_a = n;
    else return { error: 'asignado_invalido' };
  }
  return { campos };
}

const nombre = (alias) => `coalesce(${alias}.display_name, ${alias}.name, ${alias}.email)`;
const SELECT_TAREA = `
  SELECT t.id, t.titulo, t.detalle, t.estado, t.prioridad, t.asignado_a, t.creado_por, t.hecha_por,
         t.hecha_at, t.created_at, t.updated_at,
         ${nombre('ua')} AS asignado_nombre, ${nombre('uc')} AS creado_nombre, ${nombre('uh')} AS hecha_nombre,
         (SELECT COUNT(*)::int FROM super_tareas_notas n WHERE n.tarea_id = t.id) AS notas
    FROM super_tareas t
    LEFT JOIN app_users ua ON ua.id = t.asignado_a
    LEFT JOIN app_users uc ON uc.id = t.creado_por
    LEFT JOIN app_users uh ON uh.id = t.hecha_por`;

const ORDEN = `ORDER BY CASE t.prioridad WHEN 'alta' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.updated_at DESC`;

/** Todas las tareas abiertas y las hechas de los últimos 60 días (las viejas no hacen falta en pantalla). */
async function listar() {
  const { rows } = await pool.query(
    `${SELECT_TAREA} WHERE t.estado <> 'hecha' OR t.hecha_at > now() - interval '60 days' ${ORDEN} LIMIT 500`);
  return { tareas: rows };
}

async function detalle(id) {
  const { rows } = await pool.query(`${SELECT_TAREA} WHERE t.id = $1`, [id]);
  if (!rows[0]) return null;
  const { rows: notas } = await pool.query(
    `SELECT n.id, n.texto, n.autor_id, n.created_at, ${nombre('u')} AS autor
       FROM super_tareas_notas n LEFT JOIN app_users u ON u.id = n.autor_id
      WHERE n.tarea_id = $1 ORDER BY n.created_at`, [id]);
  return { ...rows[0], lista_notas: notas };
}

async function crear(datos, userId) {
  const v = validarCambios(datos, { nueva: true });
  if (v.error) return v;
  const c = v.campos;
  const { rows } = await pool.query(
    `INSERT INTO super_tareas (titulo, detalle, estado, prioridad, asignado_a, creado_por, hecha_por, hecha_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $3 = 'hecha' THEN $6::bigint END, CASE WHEN $3 = 'hecha' THEN now() END)
     RETURNING id`,
    [c.titulo, c.detalle ?? null, c.estado || 'pendiente', c.prioridad || 'normal', c.asignado_a ?? null, userId]);
  const tarea = await detalle(rows[0].id);
  await actividad.registrar(userId, 'tarea', 'agregó una tarea', { titulo: tarea.titulo, detalle: tarea.detalle, tarea_id: tarea.id });
  return { tarea };
}

const NOMBRE_PRIORIDAD = { alta: 'Alta', normal: 'Normal', baja: 'Baja' };
const primerNombre = (s) => String(s || '').split(/[\s@]/)[0];

/** Qué se hizo, en palabras: "marcó como hecha", "le asignó la tarea a Diego"… */
function describirCambios(c, tarea) {
  const partes = [];
  if (c.estado === 'hecha') partes.push('marcó como hecha');
  else if (c.estado === 'en_curso') partes.push('empezó');
  else if (c.estado === 'pendiente') partes.push('volvió a pendiente');
  if (c.asignado_a !== undefined) {
    partes.push(c.asignado_a ? `le asignó la tarea a ${primerNombre(tarea?.asignado_nombre) || 'alguien'}` : 'dejó la tarea sin asignar');
  }
  if (c.prioridad) partes.push(`cambió la prioridad a ${NOMBRE_PRIORIDAD[c.prioridad]}`);
  if (c.titulo !== undefined || c.detalle !== undefined) partes.push('editó la tarea');
  return partes.join(' y ');
}

async function actualizar(id, cambios, userId) {
  const v = validarCambios(cambios);
  if (v.error) return v;
  const entradas = Object.entries(v.campos);
  if (!entradas.length) return { error: 'nada_para_cambiar' };
  const params = [id];
  const sets = entradas.map(([col, val]) => { params.push(val); return `${col} = $${params.length}`; });
  if (v.campos.estado === 'hecha') {
    params.push(userId);
    sets.push(`hecha_at = COALESCE(hecha_at, now()), hecha_por = COALESCE(hecha_por, $${params.length})`);
  } else if (v.campos.estado) {
    sets.push('hecha_at = NULL, hecha_por = NULL');
  }
  const { rowCount } = await pool.query(`UPDATE super_tareas SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  if (!rowCount) return { error: 'no_encontrada', status: 404 };
  const tarea = await detalle(id);
  await actividad.registrar(userId, 'tarea', describirCambios(v.campos, tarea), { titulo: tarea.titulo, tarea_id: id });
  return { tarea };
}

async function borrar(id, userId) {
  const { rows } = await pool.query('DELETE FROM super_tareas WHERE id = $1 RETURNING titulo', [id]);
  if (!rows[0]) return { error: 'no_encontrada', status: 404 };
  await actividad.registrar(userId, 'tarea', 'borró una tarea', { titulo: rows[0].titulo });
  return { borrada: true };
}

async function agregarNota(id, texto, userId) {
  const t = corto(texto, 4000);
  if (!t) return { error: 'nota_vacia' };
  const { rowCount } = await pool.query('SELECT 1 FROM super_tareas WHERE id = $1', [id]);
  if (!rowCount) return { error: 'no_encontrada', status: 404 };
  await pool.query('INSERT INTO super_tareas_notas (tarea_id, autor_id, texto) VALUES ($1, $2, $3)', [id, userId, t]);
  await pool.query('UPDATE super_tareas SET updated_at = now() WHERE id = $1', [id]);
  const tarea = await detalle(id);
  await actividad.registrar(userId, 'nota', 'agregó una nota', { titulo: tarea.titulo, detalle: t, tarea_id: id });
  return { tarea };
}

/** Cada uno borra solo sus propias notas. */
async function borrarNota(tareaId, notaId, userId) {
  const { rowCount } = await pool.query(
    'DELETE FROM super_tareas_notas WHERE id = $1 AND tarea_id = $2 AND autor_id = $3', [notaId, tareaId, userId]);
  if (!rowCount) return { error: 'no_es_tuya', status: 403 };
  const tarea = await detalle(tareaId);
  if (tarea) await actividad.registrar(userId, 'nota', 'borró una nota', { titulo: tarea.titulo, tarea_id: tareaId });
  return { tarea };
}

module.exports = {
  ESTADOS, PRIORIDADES, validarCambios, describirCambios,
  listar, detalle, crear, actualizar, borrar, agregarNota, borrarNota,
};
