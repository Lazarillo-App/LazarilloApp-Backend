// services/claudeSync.js
//
// Pendientes de desarrollo que carga Claude sin iniciar sesión (Diego 15/11/2026: «no dependas de
// mí»). Claude no escribe contraseñas, así que en vez de usar la API con su usuario deja cada
// cambio en claude/sync.json (en el repo, vía PR) y el servidor lo aplica al arrancar.
//
// Cada entrada tiene una `clave` única y se aplica UNA sola vez (tabla claude_sync): la base es la
// misma para testing y producción y los dos servicios arrancan, el primero que la reclama la aplica.
// Pasa por tableroService como el usuario Claude (51): queda en la actividad igual que desde el panel.
//
// Tipos:
//   { clave, tipo: 'tarea', titulo, detalle?, modulo?, prioridad?, estado?, business_id?, solicitante_id? }
//      → crea el pendiente; si ya hay uno con ese título, no lo duplica (le suma el detalle como nota).
//   { clave, tipo: 'cambio', id | titulo, estado?, prioridad?, modulo?, detalle?, nota? }
//      → cambia una tarea existente y/o le agrega una nota.
//   { clave, tipo: 'guia', texto }  → reemplaza la Guía del proyecto.
//   { clave, tipo: 'guia_parche', buscar, reemplazar }
//      → cambia un pedazo de la Guía vigente (buscar tiene que aparecer UNA vez): así no hay que
//        reescribir las 20 mil letras para sumar una regla (17/11/2026).
//   { clave, tipo: 'manual_seccion', capitulo, seccion, campo?, buscar, reemplazar }
//      → corrige el texto de una sección del Manual (manual_capitulos.secciones[id = seccion]);
//        campo por defecto 'texto'. Si buscar no está (alguien ya lo editó), no toca nada.
'use strict';

const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const tablero = require('./tableroService');

const CLAUDE_USER_ID = 51;
const ARCHIVO = path.join(__dirname, '..', 'claude', 'sync.json');

async function buscarTarea(e) {
  if (e.id) return Number(e.id);
  if (!e.titulo) return null;
  const { rows } = await pool.query(
    'SELECT id FROM super_tareas WHERE lower(trim(titulo)) = lower(trim($1)) ORDER BY id LIMIT 1', [e.titulo]);
  return rows[0]?.id ?? null;
}

async function aplicar(e) {
  if (e.tipo === 'tarea') {
    const existe = await buscarTarea({ titulo: e.titulo });
    if (existe) {
      if (e.detalle) await tablero.agregarNota(existe, e.detalle, CLAUDE_USER_ID);
      return { yaExistia: existe };
    }
    const { clave, tipo, ...datos } = e; // eslint-disable-line no-unused-vars
    return tablero.crear({ solicitante_id: 2, ...datos }, CLAUDE_USER_ID);
  }
  if (e.tipo === 'cambio') {
    const id = await buscarTarea(e);
    if (!id) return { error: 'no_encontrada' };
    const cambios = {};
    for (const k of ['estado', 'prioridad', 'modulo', 'detalle', 'asignado_a', 'business_id']) if (e[k] !== undefined) cambios[k] = e[k];
    const out = {};
    if (Object.keys(cambios).length) out.cambio = await tablero.actualizar(id, cambios, CLAUDE_USER_ID);
    if (e.nota) out.nota = await tablero.agregarNota(id, e.nota, CLAUDE_USER_ID);
    return { id, error: out.cambio?.error || out.nota?.error };
  }
  if (e.tipo === 'guia') return tablero.guardarGuia(e.texto, CLAUDE_USER_ID);
  if (e.tipo === 'guia_parche') {
    const { rows } = await pool.query('SELECT texto FROM super_guia WHERE id = 1');
    const texto = rows[0]?.texto || '';
    if (!e.buscar || texto.split(e.buscar).length !== 2) return { error: 'buscar_no_unico' };
    return tablero.guardarGuia(texto.replace(e.buscar, () => e.reemplazar ?? ''), CLAUDE_USER_ID);
  }
  if (e.tipo === 'manual_seccion') {
    const campo = e.campo || 'texto';
    const { rows } = await pool.query('SELECT secciones FROM manual_capitulos WHERE id = $1', [e.capitulo]);
    const secciones = rows[0]?.secciones;
    if (!Array.isArray(secciones)) return { error: 'capitulo_no_encontrado' };
    const sec = secciones.find((x) => x?.id === e.seccion);
    const actual = String(sec?.[campo] ?? '');
    if (!sec || !e.buscar || actual.split(e.buscar).length !== 2) return { error: 'buscar_no_unico' };
    sec[campo] = actual.replace(e.buscar, () => e.reemplazar ?? '');
    await pool.query('UPDATE manual_capitulos SET secciones = $2::jsonb, updated_at = NOW(), updated_by = $3 WHERE id = $1',
      [e.capitulo, JSON.stringify(secciones), CLAUDE_USER_ID]);
    return { id: e.capitulo };
  }
  return { error: 'tipo_desconocido' };
}

async function correr() {
  let entradas;
  try { entradas = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch { return; }
  if (!Array.isArray(entradas) || !entradas.length) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS claude_sync (
    clave TEXT PRIMARY KEY, aplicado_at TIMESTAMPTZ NOT NULL DEFAULT now(), resultado JSONB)`);
  for (const e of entradas) {
    if (!e?.clave || !e?.tipo) continue;
    const { rows } = await pool.query(
      'INSERT INTO claude_sync (clave) VALUES ($1) ON CONFLICT (clave) DO NOTHING RETURNING clave', [e.clave]);
    if (!rows.length) continue; // ya aplicada (o la está aplicando el otro servicio)
    let resultado;
    try {
      const r = await aplicar(e);
      resultado = r?.error ? { error: r.error } : { ok: true, id: r?.tarea?.id ?? r?.id ?? r?.yaExistia ?? null };
    } catch (err) {
      resultado = { error: err.message };
    }
    if (resultado.error) console.error(`[claude-sync] ${e.clave}:`, resultado.error);
    await pool.query('UPDATE claude_sync SET resultado = $2 WHERE clave = $1', [e.clave, JSON.stringify(resultado)]);
  }
}

function programar() {
  setTimeout(() => { correr().catch((err) => console.error('[claude-sync]', err.message)); }, 30_000).unref?.();
}

module.exports = { programar, correr, aplicar };
