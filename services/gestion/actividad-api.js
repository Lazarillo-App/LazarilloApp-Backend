// services/gestion/actividad-api.js
// Campanita de actividad y block de notas. Port de lazarillo_gestion (app/api/actividad/**, app/api/notas).
// La actividad se ve por negocio; las notas son de cada usuario en cada negocio.
'use strict';

const { z } = require('zod');
const { sql, db } = require('./db');
const { ErrorDatos } = require('./dashboard/resultados-api');
const { restaurarFacturaEliminada } = require('./carga-api');

const rechazo = (mensaje, status = 400) => {
  const e = new ErrorDatos(mensaje);
  e.status = status;
  return e;
};

// La mía (por defecto) o la de todos, lo más nuevo primero.
async function listarActividad({ organizationId, businessId, usuario, sp }) {
  const todos = sp.get('todos') === '1';
  const limite = Math.min(Math.max(Number(sp.get('limite')) || 20, 1), 200);
  const filas = await db.many(sql`
    SELECT id, tipo, accion, descripcion, "refId", usuario, datos, "creadoEn" FROM gestion_actividad
    WHERE organization_id = ${organizationId} AND business_id = ${businessId}
      ${todos ? sql`` : sql`AND usuario = ${usuario}`}
    ORDER BY "creadoEn" DESC, id DESC
    LIMIT ${limite + 1}`);
  // Lo que ya no existe (factura borrada, o editada con otra sucursal o concepto) no se ofrece abrir.
  const refIds = [...new Set(filas.map((a) => a.refId).filter(Boolean))];
  const vivas = new Set(refIds.length
    ? (await db.many(sql`SELECT "rowId" FROM gestion_compras WHERE business_id = ${businessId} AND "rowId" = ANY(${refIds}::text[])`)).map((c) => c.rowId)
    : []);
  return {
    yo: usuario,
    hayMas: filas.length > limite,
    data: filas.slice(0, limite).map((a) => ({
      id: a.id, tipo: a.tipo, accion: a.accion, descripcion: a.descripcion, refId: a.refId && vivas.has(a.refId) ? a.refId : null,
      usuario: a.usuario, creadoEn: new Date(a.creadoEn).toISOString(),
      restaurable: a.tipo === 'factura' && a.accion === 'eliminada' && !!a.datos?.payload && !a.datos?.restauradaEn,
    })),
  };
}

const leerNota = async ({ businessId, userId }) => {
  const n = await db.one(sql`SELECT texto, "actualizadoEn" FROM gestion_notas_usuario WHERE user_id = ${userId} AND business_id = ${businessId}`);
  return { texto: n?.texto ?? '', actualizadoEn: n?.actualizadoEn ?? null };
};

async function guardarNota({ businessId, userId, body }) {
  const b = z.object({ texto: z.string().max(20000) }).safeParse(body);
  if (!b.success) throw rechazo('Datos inválidos');
  const n = await db.one(sql`
    INSERT INTO gestion_notas_usuario (user_id, business_id, texto) VALUES (${userId}, ${businessId}, ${b.data.texto})
    ON CONFLICT (user_id, business_id) DO UPDATE SET texto = EXCLUDED.texto, "actualizadoEn" = CURRENT_TIMESTAMP
    RETURNING "actualizadoEn"`);
  return { ok: true, actualizadoEn: n.actualizadoEn };
}

// ── Tareas (to-do) del cajón de Notas: de cada usuario en cada negocio (Diego 12/11/2026). ──
// Pendientes todas (las más viejas arriba, en el orden en que se anotaron) + las hechas de los últimos
// 60 días: pasado eso desaparecen de la lista (Diego 12/11/2026). No se borran de la tabla.
const fila = (t) => ({
  id: Number(t.id), texto: t.texto,
  creadaEn: new Date(t.creadaEn).toISOString(),
  hechaEn: t.hechaEn ? new Date(t.hechaEn).toISOString() : null,
});

async function listarTareas({ businessId, userId }) {
  const filas = await db.many(sql`
    (SELECT id, texto, "creadaEn", "hechaEn" FROM gestion_tareas_usuario
      WHERE user_id = ${userId} AND business_id = ${businessId} AND "hechaEn" IS NULL)
    UNION ALL
    (SELECT id, texto, "creadaEn", "hechaEn" FROM gestion_tareas_usuario
      WHERE user_id = ${userId} AND business_id = ${businessId} AND "hechaEn" >= CURRENT_TIMESTAMP - INTERVAL '60 days'
      ORDER BY "hechaEn" DESC LIMIT 500)`);
  const pendientes = filas.filter((t) => !t.hechaEn).sort((a, b) => new Date(a.creadaEn) - new Date(b.creadaEn) || a.id - b.id);
  const hechas = filas.filter((t) => t.hechaEn).sort((a, b) => new Date(b.hechaEn) - new Date(a.hechaEn));
  return { pendientes: pendientes.map(fila), hechas: hechas.map(fila) };
}

const textoTarea = z.string().trim().min(1).max(500);

async function crearTarea({ businessId, userId, body }) {
  const b = z.object({ texto: textoTarea }).safeParse(body);
  if (!b.success) throw rechazo('Escribí la tarea');
  const t = await db.one(sql`
    INSERT INTO gestion_tareas_usuario (user_id, business_id, texto) VALUES (${userId}, ${businessId}, ${b.data.texto})
    RETURNING id, texto, "creadaEn", "hechaEn"`);
  return fila(t);
}

// Tildar (hecha: true → fecha de baja = ahora), destildar (vuelve a pendiente) o corregir el texto.
async function editarTarea({ businessId, userId, id, body }) {
  const b = z.object({ hecha: z.boolean().optional(), texto: textoTarea.optional() }).safeParse(body);
  if (!b.success || !Number.isFinite(id)) throw rechazo('Datos inválidos');
  const { hecha, texto } = b.data;
  const t = await db.one(sql`
    UPDATE gestion_tareas_usuario SET
      texto = COALESCE(${texto ?? null}::text, texto),
      "hechaEn" = CASE WHEN ${hecha ?? null}::boolean IS NULL THEN "hechaEn"
                       WHEN ${hecha ?? null}::boolean THEN COALESCE("hechaEn", CURRENT_TIMESTAMP) ELSE NULL END
    WHERE id = ${id} AND user_id = ${userId} AND business_id = ${businessId}
    RETURNING id, texto, "creadaEn", "hechaEn"`);
  if (!t) throw rechazo('La tarea no existe', 404);
  return fila(t);
}

async function borrarTarea({ businessId, userId, id }) {
  if (!Number.isFinite(id)) throw rechazo('Datos inválidos');
  await db.one(sql`DELETE FROM gestion_tareas_usuario WHERE id = ${id} AND user_id = ${userId} AND business_id = ${businessId} RETURNING id`);
  return { ok: true };
}

module.exports = { listarActividad, restaurarFacturaEliminada, leerNota, guardarNota, listarTareas, crearTarea, editarTarea, borrarTarea };
