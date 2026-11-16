// services/manualService.js — capítulos del Manual de Lazarillo (tabla manual_capitulos, migración 139).
const pool = require('../config/db');
const actividad = require('./superActividadService');

const COLS = 'id, grupo, titulo, resumen, guia_id, orden, secciones, publicado, updated_at';
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Todos los capítulos publicados (son pocos y livianos: el índice y el buscador usan todo). */
async function listar({ conBorradores = false } = {}) {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM manual_capitulos ${conBorradores ? '' : 'WHERE publicado'} ORDER BY grupo, orden, titulo`);
  return { capitulos: rows };
}

async function leer(id) {
  const { rows } = await pool.query(`SELECT ${COLS} FROM manual_capitulos WHERE id = $1`, [String(id)]);
  return rows[0] || null;
}

const txt = (v, max) => String(v ?? '').trim().slice(0, max);
function limpiarSecciones(lista) {
  if (!Array.isArray(lista)) return [];
  return lista.slice(0, 40).map((s, i) => ({
    id: SLUG.test(String(s?.id || '')) ? String(s.id) : `seccion-${i + 1}`,
    titulo: txt(s?.titulo, 160),
    texto: txt(s?.texto, 6000),
    // https://… o una imagen propia del manual (/api/manual/imagen/:id, sirve en testing y producción).
    imagen: /^(https:\/\/|\/api\/manual\/imagen\/\d+$)/.test(String(s?.imagen || '')) ? txt(s.imagen, 600) : '',
    pie: txt(s?.pie, 240),
    tip: txt(s?.tip, 600),
  }));
}

/** Crea o reemplaza un capítulo (super usuarios). Queda en la actividad del Panel super. */
async function guardar(id, body, userId) {
  if (!SLUG.test(String(id || ''))) return { error: 'id_invalido' };
  const b = body || {};
  if (!txt(b.titulo, 160) || !txt(b.grupo, 60)) return { error: 'faltan_datos' };
  const previo = await leer(id);
  await pool.query(
    `INSERT INTO manual_capitulos (id, grupo, titulo, resumen, guia_id, orden, secciones, publicado, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now(), $9)
     ON CONFLICT (id) DO UPDATE SET grupo = EXCLUDED.grupo, titulo = EXCLUDED.titulo, resumen = EXCLUDED.resumen,
       guia_id = EXCLUDED.guia_id, orden = EXCLUDED.orden, secciones = EXCLUDED.secciones, publicado = EXCLUDED.publicado,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [id, txt(b.grupo, 60), txt(b.titulo, 160), txt(b.resumen, 1200), txt(b.guia_id, 60) || null,
      Number.isFinite(Number(b.orden)) ? Number(b.orden) : 0, JSON.stringify(limpiarSecciones(b.secciones)), b.publicado !== false, userId]);
  await actividad.registrar(userId, 'manual', previo ? 'editó un capítulo del manual' : 'agregó un capítulo al manual',
    { titulo: `Manual: ${txt(b.titulo, 160)}` });
  return { capitulo: await leer(id) };
}

async function borrar(id, userId) {
  const previo = await leer(id);
  if (!previo) return { error: 'no_encontrado', status: 404 };
  await pool.query('DELETE FROM manual_capitulos WHERE id = $1', [String(id)]);
  await actividad.registrar(userId, 'manual', 'borró un capítulo del manual', { titulo: `Manual: ${previo.titulo}` });
  return { borrado: id };
}

/** Guarda una imagen del manual y devuelve su ruta (/api/manual/imagen/:id). */
async function guardarImagen(file, userId) {
  const { rows } = await pool.query(
    'INSERT INTO manual_imagenes (mime, datos, bytes, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
    [file.mimetype, file.buffer, file.size, userId]);
  return `/api/manual/imagen/${rows[0].id}`;
}
async function leerImagen(id) {
  const { rows } = await pool.query('SELECT mime, datos FROM manual_imagenes WHERE id = $1', [Number(id) || 0]);
  return rows[0] || null;
}

module.exports = { listar, leer, guardar, borrar, guardarImagen, leerImagen };
