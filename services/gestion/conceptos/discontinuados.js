// Rubros y conceptos de caja discontinuados (Diego 20/11 y 24/11/2026). Para toda la organización
// (business_id NULL) o solo en algunos negocios. No se borra nada: lo discontinuado deja de ofrecerse al
// cargar en ese negocio; lo ya cargado sigue igual. Reactivar lo vuelve a ofrecer.
'use strict';

const { sql, db } = require('../db');
const { ErrorDatos } = require('../dashboard/resultados-api');

const rechazo = (m) => { const e = new ErrorDatos(m); e.status = 422; return e; };

async function listar({ organizationId }) {
  const filas = await db.many(sql`
    SELECT tipo, TRIM(codigo) AS codigo, business_id AS "businessId", "creadoPor", TO_CHAR("creadoEn", 'YYYY-MM-DD') AS desde
      FROM gestion_conceptos_discontinuados WHERE organization_id = ${organizationId}`);
  return filas.map((f) => ({ ...f, businessId: f.businessId == null ? null : Number(f.businessId) }));
}

function leer(body) {
  const tipo = body?.tipo;
  const codigo = String(body?.codigo ?? '').trim();
  if (!['rubro', 'concepto'].includes(tipo) || !codigo) throw rechazo('Datos inválidos');
  const ids = body?.businessIds == null ? null : [...new Set([].concat(body.businessIds).map(Number))];
  if (ids && (!ids.length || ids.some((n) => !Number.isInteger(n) || n <= 0))) throw rechazo('Elegí al menos un negocio');
  return { tipo, codigo, ids };
}

async function nombreDe(tx, organizationId, tipo, codigo) {
  const t = tipo === 'rubro'
    ? await tx.one(sql`SELECT TRIM(nombre) AS n FROM gestion_rubros_concepto_caja WHERE organization_id = ${organizationId} AND TRIM(codigo) = ${codigo}`)
    : await tx.one(sql`SELECT TRIM(nombre) AS n FROM gestion_conceptos_caja WHERE organization_id = ${organizationId} AND TRIM(codigo::text) = ${codigo}`);
  if (!t) throw rechazo(tipo === 'rubro' ? 'El rubro no existe' : 'El concepto no existe');
  return t.n;
}

async function negociosDe(tx, organizationId, ids) {
  const filas = await tx.many(sql`SELECT id, name FROM app_businesses WHERE organization_id = ${organizationId}`);
  if (ids && ids.some((id) => !filas.some((f) => Number(f.id) === id))) throw rechazo('Ese negocio no es de esta organización');
  return filas;
}

const avisar = (businessId, actorUserId, title, metadata) =>
  require('../../notificationService').avisarAlEquipoSinEsperar({ businessId, actorUserId, type: 'conceptos_discontinuados', title, metadata });

// Discontinuar: reemplaza el alcance que tenía (toda la organización o la lista de negocios dada).
async function discontinuar({ organizationId, businessId, usuario, actorUserId, body }) {
  const { tipo, codigo, ids } = leer(body);
  const r = await db.transaction(async (tx) => {
    const nombre = await nombreDe(tx, organizationId, tipo, codigo);
    const negocios = await negociosDe(tx, organizationId, ids);
    await tx.execute(sql`DELETE FROM gestion_conceptos_discontinuados WHERE organization_id = ${organizationId} AND tipo = ${tipo} AND TRIM(codigo) = ${codigo}`);
    const destinos = ids ?? [null];
    for (const b of destinos) {
      await tx.execute(sql`INSERT INTO gestion_conceptos_discontinuados (organization_id, tipo, codigo, business_id, "creadoPor")
        VALUES (${organizationId}, ${tipo}, ${codigo}, ${b}, ${usuario})`);
    }
    const donde = ids ? negocios.filter((n) => ids.includes(Number(n.id))).map((n) => String(n.name).trim()).join(', ') : 'toda la organización';
    return { nombre, donde };
  });
  avisar(businessId, actorUserId, `Discontinuado: ${tipo === 'rubro' ? 'rubro' : 'concepto'} ${r.nombre} (${r.donde})`, { tipo, codigo, businessIds: ids });
  return { ok: true, discontinuados: await listar({ organizationId }) };
}

async function reactivar({ organizationId, businessId, actorUserId, body }) {
  const { tipo, codigo } = leer({ ...body, businessIds: null });
  const nombre = await nombreDe(db, organizationId, tipo, codigo);
  await db.execute(sql`DELETE FROM gestion_conceptos_discontinuados WHERE organization_id = ${organizationId} AND tipo = ${tipo} AND TRIM(codigo) = ${codigo}`);
  avisar(businessId, actorUserId, `Reactivado: ${tipo === 'rubro' ? 'rubro' : 'concepto'} ${nombre}`, { tipo, codigo });
  return { ok: true, discontinuados: await listar({ organizationId }) };
}

module.exports = { listar, discontinuar, reactivar };
