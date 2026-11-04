// services/gestion/apertura/api.js
// Reglas de apertura: listar, crear, editar, desactivar, borrar y previsualizar. Port de
// lazarillo_gestion/app/api/apertura/reglas/**.
//
// Hacia el front conserva los nombres de gestion: localId = negocio, puntoDeVentaId = lugar
// (-negocio la principal, positivo una sucursal).
//
// Permisos: una regla carga gastos en otro negocio, así que quien la crea, edita o borra tiene que
// ser owner o admin del negocio de origen y de cada negocio de destino. Las respuestas solo muestran
// reglas en las que participa el negocio activo.
'use strict';

const { sql, db } = require('../db');
const { ErrorDatos } = require('../dashboard/resultados-api');
const { idLugar } = require('../carga-api');
const { getEffectiveRole } = require('../../auth/accessControl');
const { crearReglaSchema, patchReglaSchema, previewTotalQuerySchema } = require('./schemas');
const { resolverVigencia, vigenciaToSql, FECHA_EFECTIVA_COMPRA_SQL } = require('./vigencia');
const motor = require('./motor');

const rechazo = (mensaje, status = 400, extra) => {
  const e = new ErrorDatos(mensaje);
  e.status = status;
  e.extra = extra;
  return e;
};
const invalido = (parsed) => rechazo('Datos inválidos', 422, { issues: parsed.error.issues });

// Lugares de la organización a los que este usuario le puede cargar gastos.
async function obtenerLocalesApertura({ organizationId, userId }) {
  const negocios = await db.many(sql`SELECT id, name FROM app_businesses WHERE organization_id = ${organizationId} ORDER BY name`);
  const roles = await Promise.all(negocios.map((n) => getEffectiveRole(userId, n.id)));
  const propios = negocios.filter((_, i) => ['owner', 'admin'].includes(roles[i]));
  const ids = propios.map((n) => n.id);
  const sucursales = ids.length ? await db.many(sql`
    SELECT id, name, business_id FROM app_branches
    WHERE business_id = ANY(${ids}::bigint[]) AND NOT COALESCE((props->>'is_main')::boolean, false) ORDER BY name`) : [];
  return propios.map((n) => ({
    id: Number(n.id),
    nombre: n.name,
    puntosDeVenta: [
      { id: idLugar(n.id, null), localId: Number(n.id), nombre: 'Principal' },
      ...sucursales.filter((s) => String(s.business_id) === String(n.id)).map((s) => ({ id: Number(s.id), localId: Number(n.id), nombre: s.name })),
    ],
  }));
}

// Pasa un lugar del front a (negocio, sucursal), validando que sea de esta organización y que el
// usuario pueda administrarlo. "Todo el local" no existe acá: sin lugar puntual va a la principal.
async function resolverLugar(cliente, { organizationId, userId }, localId, puntoDeVentaId) {
  let businessId;
  let branchId = null;
  if (puntoDeVentaId != null && puntoDeVentaId > 0) {
    const s = await cliente.one(sql`
      SELECT br.business_id FROM app_branches br JOIN app_businesses b ON b.id = br.business_id
      WHERE br.id = ${puntoDeVentaId} AND b.organization_id = ${organizationId}`);
    if (!s) throw rechazo('Esa sucursal no existe.', 422);
    businessId = Number(s.business_id);
    branchId = puntoDeVentaId;
  } else {
    businessId = puntoDeVentaId != null ? -puntoDeVentaId : Number(localId);
    const b = await cliente.one(sql`SELECT id FROM app_businesses WHERE id = ${businessId} AND organization_id = ${organizationId}`);
    if (!b) throw rechazo('Ese negocio no es de esta organización.', 422);
  }
  if (!['owner', 'admin'].includes(await getEffectiveRole(userId, businessId))) {
    throw rechazo('No tenés permisos sobre uno de los negocios de la regla.', 403);
  }
  return { businessId, branchId };
}

const vigenciaDesde = (d) => ({
  modo: d.modo,
  fechaDesde: d.fechaDesde ? new Date(d.fechaDesde) : null,
  fechaHasta: d.fechaHasta ? new Date(d.fechaHasta) : null,
  extremosInclusivos: d.extremosInclusivos,
});
const fechaParam = (f) => (f ? f.toISOString() : null);

async function leerReglas(cliente, where) {
  const reglas = await cliente.many(sql`
    SELECT r.id, r.nivel, r."entidadId", r.business_id, r.branch_id, r.modo, r."fechaDesde", r."fechaHasta", r."extremosInclusivos", r.estado, r."creadoPor", r."creadoEn"
    FROM gestion_reglas_apertura r WHERE ${where} ORDER BY r."creadoEn" DESC`);
  const ids = reglas.map((r) => r.id);
  const destinos = ids.length ? await cliente.many(sql`SELECT id, "reglaId", business_id, branch_id, porcentaje FROM gestion_destinos_regla WHERE "reglaId" = ANY(${ids}::int[])`) : [];
  return reglas.map(({ business_id, branch_id, ...r }) => ({
    ...r,
    origenLocalId: Number(business_id),
    origenPuntoDeVentaId: idLugar(business_id, branch_id),
    destinos: destinos.filter((d) => d.reglaId === r.id).map((d) => ({
      id: d.id, reglaId: d.reglaId, localId: Number(d.business_id), puntoDeVentaId: idLugar(d.business_id, d.branch_id), porcentaje: String(d.porcentaje),
    })),
  }));
}

async function listarReglas({ organizationId, businessId }) {
  return {
    data: await leerReglas(db, sql`r.organization_id = ${organizationId} AND (r.business_id = ${businessId}
      OR EXISTS (SELECT 1 FROM gestion_destinos_regla d WHERE d."reglaId" = r.id AND d.business_id = ${businessId}))`),
  };
}

const leerUna = async (cliente, id) => (await leerReglas(cliente, sql`r.id = ${id}`))[0];

async function insertarDestinos(tx, reglaId, destinos) {
  const filas = await tx.many(sql`
    INSERT INTO gestion_destinos_regla ("reglaId", business_id, branch_id, porcentaje)
    VALUES ${sql.join(destinos.map((d) => sql`(${reglaId}, ${d.businessId}, ${d.branchId}::bigint, ${d.porcentaje}::numeric)`), ", ")}
    RETURNING id, porcentaje`);
  return filas.map((d) => ({ id: d.id, porcentaje: Number(d.porcentaje) }));
}

// Dos destinos no pueden ser el mismo lugar (el schema lo controla con los ids del front, esto cubre
// la principal escrita de dos formas).
function exigirDestinosDistintos(destinos) {
  const vistos = new Set();
  for (const d of destinos) {
    const k = `${d.businessId}|${d.branchId}`;
    if (vistos.has(k)) throw rechazo('Hay dos destinos iguales.', 422);
    vistos.add(k);
  }
}

const superposicionA409 = (err) => {
  if (err instanceof motor.SuperposicionError) throw rechazo(err.message, 409);
  throw err;
};

async function crearRegla({ organizationId, userId, usuario, body }) {
  const parsed = crearReglaSchema.safeParse(body);
  if (!parsed.success) throw invalido(parsed);
  const d = parsed.data;
  const vigencia = vigenciaDesde(d);
  const ctx = { organizationId, userId };
  const resultado = await db.transaction(async (tx) => {
    await motor.tomarLockDeAplicacion(tx, organizationId);
    const origen = await resolverLugar(tx, ctx, d.origenLocalId, d.origenPuntoDeVentaId);
    await motor.verificarSinSuperposicion(tx, organizationId, d.nivel, d.entidadId, vigencia, origen);
    const lugares = [];
    for (const x of d.destinos) lugares.push({ ...(await resolverLugar(tx, ctx, x.localId, x.puntoDeVentaId)), porcentaje: x.porcentaje });
    exigirDestinosDistintos(lugares);
    const { id } = await tx.one(sql`
      INSERT INTO gestion_reglas_apertura (organization_id, business_id, branch_id, nivel, "entidadId", modo, "fechaDesde", "fechaHasta", "extremosInclusivos", "creadoPor")
      VALUES (${organizationId}, ${origen.businessId}, ${origen.branchId}::bigint, ${d.nivel}, ${d.entidadId}, ${d.modo},
              ${fechaParam(vigencia.fechaDesde)}::timestamp, ${fechaParam(vigencia.fechaHasta)}::timestamp, ${d.extremosInclusivos}, ${usuario})
      RETURNING id`);
    const destinos = await insertarDestinos(tx, id, lugares);
    const vigenciaSql = vigenciaToSql(resolverVigencia(vigencia), FECHA_EFECTIVA_COMPRA_SQL);
    await motor.liberarComprasReclamables(tx, d.nivel, d.entidadId, vigenciaSql, origen);
    const { comprasAfectadas } = await motor.aplicarRegla(tx, organizationId, { reglaId: id, nivel: d.nivel, entidadId: d.entidadId, vigencia, origen, destinos });
    return { data: await leerUna(tx, id), comprasAfectadas };
  }).catch(superposicionA409);
  return resultado;
}

// La regla, si el usuario puede tocarla (permisos sobre el origen y sobre todos sus destinos).
async function reglaEditable(cliente, { organizationId, userId }, id) {
  if (!Number.isInteger(id) || id <= 0) throw rechazo('id inválido');
  const r = await cliente.one(sql`SELECT id, nivel, "entidadId", business_id FROM gestion_reglas_apertura WHERE id = ${id} AND organization_id = ${organizationId}`);
  if (!r) throw rechazo('Regla no encontrada', 404);
  const dest = await cliente.many(sql`SELECT DISTINCT business_id FROM gestion_destinos_regla WHERE "reglaId" = ${id}`);
  for (const biz of new Set([String(r.business_id), ...dest.map((x) => String(x.business_id))])) {
    if (!['owner', 'admin'].includes(await getEffectiveRole(userId, Number(biz)))) {
      throw rechazo('No tenés permisos sobre uno de los negocios de la regla.', 403);
    }
  }
  return r;
}

async function editarRegla({ organizationId, userId, id, body }) {
  const parsed = patchReglaSchema.safeParse(body);
  if (!parsed.success) throw invalido(parsed);
  const ctx = { organizationId, userId };
  const existente = await reglaEditable(db, ctx, id);

  if (parsed.data.accion === 'desactivar') {
    // Solo detiene lo futuro: lo ya repartido queda como historial.
    await db.execute(sql`UPDATE gestion_reglas_apertura SET estado = 'inactiva' WHERE id = ${id}`);
    return { data: await leerUna(db, id) };
  }

  // Editar = revertir y reaplicar completo. Editar reactiva siempre.
  const d = parsed.data;
  const vigencia = vigenciaDesde(d);
  const { data, comprasAfectadas, rowIdsLiberados } = await db.transaction(async (tx) => {
    await motor.tomarLockDeAplicacion(tx, organizationId);
    const origenN = await resolverLugar(tx, ctx, d.origenLocalId, d.origenPuntoDeVentaId);
    await motor.verificarSinSuperposicion(tx, organizationId, existente.nivel, existente.entidadId, vigencia, origenN, id);
    const { rowIds } = await motor.revertirRegla(tx, id);
    await tx.execute(sql`DELETE FROM gestion_destinos_regla WHERE "reglaId" = ${id}`);
    const lugares = [];
    for (const x of d.destinos) lugares.push({ ...(await resolverLugar(tx, ctx, x.localId, x.puntoDeVentaId)), porcentaje: x.porcentaje });
    exigirDestinosDistintos(lugares);
    await tx.execute(sql`
      UPDATE gestion_reglas_apertura SET business_id = ${origenN.businessId}, branch_id = ${origenN.branchId}::bigint, modo = ${d.modo},
        "fechaDesde" = ${fechaParam(vigencia.fechaDesde)}::timestamp, "fechaHasta" = ${fechaParam(vigencia.fechaHasta)}::timestamp,
        "extremosInclusivos" = ${d.extremosInclusivos}, estado = 'activa'
      WHERE id = ${id}`);
    const destinos = await insertarDestinos(tx, id, lugares);
    const vigenciaSql = vigenciaToSql(resolverVigencia(vigencia), FECHA_EFECTIVA_COMPRA_SQL);
    await motor.liberarComprasReclamables(tx, existente.nivel, existente.entidadId, vigenciaSql, origenN);
    const r = await motor.aplicarRegla(tx, organizationId, { reglaId: id, nivel: existente.nivel, entidadId: existente.entidadId, vigencia, origen: origenN, destinos });
    return { data: await leerUna(tx, id), comprasAfectadas: r.comprasAfectadas, rowIdsLiberados: rowIds };
  }).catch(superposicionA409);

  // Cascada, fuera de la transacción: lo que la vigencia nueva dejó afuera puede tocarle a otra regla.
  const negocioLiberado = Number(existente.business_id);
  const { errores } = await motor.reaplicarReglasActivas({ organizationId, businessId: negocioLiberado }, { rowIds: rowIdsLiberados });
  if (errores.length) console.error('[gestion/apertura] cascada al editar', errores);
  return { data, comprasAfectadas, erroresCascada: errores };
}

async function borrarRegla({ organizationId, userId, id }) {
  const existente = await reglaEditable(db, { organizationId, userId }, id);
  const { comprasRevertidas, rowIds } = await db.transaction(async (tx) => {
    await motor.tomarLockDeAplicacion(tx, organizationId);
    const r = await motor.revertirRegla(tx, id);
    await tx.execute(sql`DELETE FROM gestion_destinos_regla WHERE "reglaId" = ${id}`);
    await tx.execute(sql`DELETE FROM gestion_reglas_apertura WHERE id = ${id}`);
    return r;
  });
  // El borrado ya está hecho: si la cascada falla, se avisa sin decir que falló borrar.
  let erroresCascada = [];
  try {
    erroresCascada = (await motor.reaplicarReglasActivas({ organizationId, businessId: Number(existente.business_id) }, { rowIds })).errores;
    if (erroresCascada.length) console.error('[gestion/apertura] cascada al borrar', erroresCascada);
  } catch (err) {
    console.error('[gestion/apertura] la cascada falló por completo', err);
    erroresCascada = ['La cascada de reaplicación falló tras eliminar esta regla: revisar qué compras quedaron sin redistribuir.'];
  }
  return { ok: true, comprasRevertidas, erroresCascada };
}

// Total del período y valor del último mes con compras, para el formulario. Solo lectura.
async function previewTotal({ organizationId, userId, sp }) {
  const parsed = previewTotalQuerySchema.safeParse({
    nivel: sp.get('nivel') ?? undefined,
    entidadId: sp.get('entidadId') ?? undefined,
    reglaId: sp.get('reglaId') ?? undefined,
    origenLocalId: sp.get('origenLocalId') ?? undefined,
    origenPuntoDeVentaId: sp.get('origenPuntoDeVentaId') ?? undefined,
    modo: sp.get('modo') ?? undefined,
    fechaDesde: sp.get('fechaDesde') ?? undefined,
    fechaHasta: sp.get('fechaHasta') ?? undefined,
    extremosInclusivos: sp.get('extremosInclusivos') !== 'false',
  });
  if (!parsed.success) throw invalido(parsed);
  const d = parsed.data;
  const origen = await resolverLugar(db, { organizationId, userId }, d.origenLocalId, d.origenPuntoDeVentaId);
  const vigenciaSql = vigenciaToSql(resolverVigencia(vigenciaDesde(d)), FECHA_EFECTIVA_COMPRA_SQL);
  const r = await db.one(sql`
    WITH elegibles AS (${motor.condicionComprasElegibles(d.nivel, d.entidadId, vigenciaSql, origen, d.reglaId ?? null)})
    SELECT
      (SELECT COALESCE(SUM("importeBase"), 0) FROM elegibles)::float8 AS total,
      (SELECT SUM("importeBase") FROM elegibles
        WHERE date_trunc('month', "fechaEfectiva") = (SELECT date_trunc('month', "fechaEfectiva") FROM elegibles ORDER BY "fechaEfectiva" DESC LIMIT 1))::float8 AS "ultimoValor"`);
  return { total: r?.total ?? 0, ultimoValor: r?.ultimoValor ?? 0 };
}

module.exports = { obtenerLocalesApertura, listarReglas, crearRegla, editarRegla, borrarRegla, previewTotal };
