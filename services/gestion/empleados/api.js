// services/gestion/empleados/api.js
// Carga de sueldos y adelantos, cuenta del empleado y concepto fijo por empleado. Port de
// lazarillo_gestion/app/api/{empleados,conceptos-empleado} y lib/empleados/{query,concepto-fijo-db}.
//
// Todo por lugar del negocio activo (pdvId: -negocio la principal, positivo una sucursal). La nómina
// es de cada lugar y los conceptos de la organización.
'use strict';

const { z } = require('zod');
const { sql, db } = require('../db');
const { ErrorDatos } = require('../dashboard/resultados-api');
const { normalizarProveedorTexto } = require('../text-normalize');
const { parsearEntidadIdProveedorTexto } = require('../proveedor-entidad-id');
const { ORIGEN_LAZARILLO } = require('../facturas/armar');
const { obtenerLugares, registrarActividad } = require('../carga-api');
const { resolverVigencia, vigenciaToSql, FECHA_EFECTIVA_COMPRA_SQL } = require('../apertura/vigencia');
const { reaplicarReglasActivas, reevaluarCompra } = require('../apertura/motor');
const { cargaEmpleadoSchema, filasEmpleado, validarSueldo } = require('./carga');
const { errorVigencia, superposicion } = require('./concepto-fijo');

const rechazo = (mensaje, status = 400, extra) => {
  const e = new ErrorDatos(mensaje);
  e.status = status;
  e.extra = extra;
  return e;
};
const detalleDe = (parsed) => ({ detalle: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
const pesos = (n) => `$ ${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function lugarDelNegocio(cliente, businessId, pdvId) {
  const lugares = await obtenerLugares(cliente, businessId);
  const lugar = lugares.find((l) => l.id === pdvId);
  if (!lugar) throw rechazo('Elegí una sucursal');
  return { lugar, lugares };
}
const enLugar = (alias, businessId, branchId) =>
  sql`${sql.raw(alias)}.business_id = ${businessId} AND ${sql.raw(alias)}.branch_id IS NOT DISTINCT FROM ${branchId}::bigint`;

// El concepto de los adelantos ("Adelanto Sueldo"; el código cambia por organización).
const conceptoAdelanto = (cliente, organizationId) => cliente.one(sql`
  SELECT codigo, TRIM(nombre) AS nombre FROM gestion_conceptos_caja
  WHERE organization_id = ${organizationId} AND nombre ILIKE 'adelanto%sueldo%' ORDER BY codigo LIMIT 1`);

// Sueldos y adelantos de un empleado: filas sin comprobante con su código y nombre, más las de las
// cargas de Lazarillo repartidas a otra sucursal (rowId "emp-<id>-…").
const movimientosEmpleado = (cliente, { organizationId, businessId, branchId, codigo, nombre, desde }) => cliente.many(sql`
  SELECT to_char(COALESCE(c.periodo, c.fecha), 'YYYY-MM') AS periodo,
         to_char(COALESCE(c."fechaPago", c."fechaManual", c.fecha), 'YYYY-MM-DD') AS fecha,
         COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") AS cod,
         TRIM(COALESCE(cc.nombre, c.concepto)) AS concepto,
         COALESCE(c."importeManual", c.importe)::float8 AS importe,
         c.origen, c."cajaPago" AS medio, c."rowId" AS "rowId"
  FROM gestion_compras c
  LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId} AND cc.codigo = COALESCE(c."conceptoCodigoManual", c."conceptoCodigo")
  WHERE c.business_id = ${businessId} AND c.comprobante IS NULL AND c."proveedorId" IS NULL AND c.codigo = ${codigo}
    AND LOWER(TRIM(c.proveedor)) = LOWER(TRIM(${nombre}))
    AND (c.branch_id IS NOT DISTINCT FROM ${branchId}::bigint OR EXISTS (
      SELECT 1 FROM gestion_liquidaciones_empleado l
      WHERE ${enLugar('l', businessId, branchId)} AND l."empleadoCodigo" = ${codigo} AND c."rowId" LIKE 'emp-' || l.id || '-%'))
    AND COALESCE(c.periodo, c.fecha) >= ${desde}::date
    AND ABS(COALESCE(c."importeManual", c.importe)) > 0.005
  ORDER BY 1 DESC, 2`);

// La nómina del lugar: activos y dados de baja hace menos de 3 meses (cobran la liquidación final).
async function obtenerNomina({ organizationId, businessId, sp }) {
  const { lugar } = await lugarDelNegocio(db, businessId, Number(sp.get('pdvId')));
  const [empleados, adelanto] = await Promise.all([
    db.many(sql`
      SELECT codigo, TRIM(nombre) AS nombre, NULLIF(TRIM(apellido), '') AS apellido, to_char("fechaBaja", 'YYYY-MM-DD') AS baja
      FROM gestion_empleados e
      WHERE ${enLugar('e', businessId, lugar.branchId)} AND NULLIF(TRIM(nombre), '') IS NOT NULL
        AND ("fechaBaja" IS NULL OR "fechaBaja" >= CURRENT_DATE - 90)
      ORDER BY TRIM(nombre), apellido`),
    conceptoAdelanto(db, organizationId),
  ]);
  return { empleados, conceptoAdelanto: adelanto ?? null };
}

const empleadoDe = (cliente, businessId, branchId, codigo) => cliente.one(sql`
  SELECT TRIM(nombre) AS nombre, NULLIF(TRIM(apellido), '') AS apellido FROM gestion_empleados e
  WHERE ${enLugar('e', businessId, branchId)} AND codigo = ${codigo} LIMIT 1`);

// Un sueldo o un adelanto cargado a mano.
async function crearCarga({ organizationId, businessId, usuario, body }) {
  const parsed = cargaEmpleadoSchema.safeParse(body);
  if (!parsed.success) throw rechazo('Datos inválidos', 400, detalleDe(parsed));
  const c = parsed.data;
  const periodo = `${c.periodo}-01`;
  const { lugar, lugares } = await lugarDelNegocio(db, businessId, c.pdvId);
  const branchDe = new Map(lugares.map((l) => [l.id, l.branchId]));
  if ((c.reparto ?? []).some((x) => x.pct > 0 && !branchDe.has(x.puntoDeVentaId))) throw rechazo('Sucursal inexistente');
  const emp = await empleadoDe(db, businessId, lugar.branchId, c.codigo);
  if (!emp) throw rechazo('Ese empleado no está en la nómina de la sucursal', 404);
  const adelanto = await conceptoAdelanto(db, organizationId);
  if (!adelanto) throw rechazo('No existe el concepto de caja "Adelanto Sueldo"');

  // Lo que ya tiene el empleado en el período (MaxiRest y Lazarillo).
  const movs = (await movimientosEmpleado(db, { organizationId, businessId, branchId: lugar.branchId, codigo: c.codigo, nombre: emp.nombre, desde: periodo }))
    .filter((m) => m.periodo === c.periodo);
  const adelantosPeriodo = Math.round(movs.filter((m) => m.cod === adelanto.codigo).reduce((s, m) => s + m.importe, 0) * 100) / 100;

  let conceptos = new Map();
  if (c.tipo === 'sueldo') {
    const problemas = validarSueldo(c, adelantosPeriodo);
    if (problemas.length) throw rechazo('No cierra', 400, { detalle: problemas });
    const cods = [...new Set(c.conceptos.map((x) => x.conceptoCodigo))];
    const cc = await db.many(sql`SELECT codigo, TRIM(nombre) AS nombre FROM gestion_conceptos_caja WHERE organization_id = ${organizationId} AND codigo = ANY(${cods}::text[])`);
    conceptos = new Map(cc.map((x) => [x.codigo, x.nombre]));
    if (cods.some((x) => !conceptos.has(x))) throw rechazo('Hay un concepto que no existe');
    // Nunca duplicar: si el período ya tiene liquidación se avisa.
    const ya = movs.filter((m) => m.cod !== adelanto.codigo);
    if (ya.length && !c.forzar) {
      throw rechazo('Ya tiene sueldo cargado en el período', 409, { parecido: { importe: ya.reduce((s, m) => s + m.importe, 0), fecha: ya[0].fecha, origen: ya[0].origen } });
    }
  } else {
    const ya = movs.find((m) => m.cod === adelanto.codigo && m.fecha === c.fechaPago && Math.abs(m.importe - c.importe) <= 1);
    if (ya && !c.forzar) throw rechazo('Ya hay un adelanto igual ese día', 409, { parecido: { importe: ya.importe, fecha: ya.fecha, origen: ya.origen } });
  }

  const nombreCompleto = [emp.nombre, emp.apellido].filter(Boolean).join(' ');
  const total = c.tipo === 'sueldo' ? c.total : c.importe;
  const res = await db.transaction(async (tx) => {
    const { id } = await tx.one(sql`
      INSERT INTO gestion_liquidaciones_empleado (business_id, branch_id, tipo, "empleadoCodigo", "empleadoNombre", periodo, "fechaPago", total, adelantos, payload, "creadoPor")
      VALUES (${businessId}, ${lugar.branchId}::bigint, ${c.tipo}, ${c.codigo}, ${emp.nombre}, ${periodo}::date, ${c.fechaPago}::date, ${total}::numeric,
              ${c.tipo === 'sueldo' ? adelantosPeriodo : 0}::numeric, ${JSON.stringify(c)}::jsonb, ${usuario})
      RETURNING id`);
    const filas = filasEmpleado(id, c);
    for (const f of filas) {
      const cod = f.conceptoCodigo || adelanto.codigo;
      const nom = f.conceptoCodigo ? conceptos.get(f.conceptoCodigo) : adelanto.nombre;
      await tx.execute(sql`
        INSERT INTO gestion_compras (business_id, branch_id, "rowId", comprobante, "codCga", concepto, fecha, codigo, proveedor, observac, importe, "importeTrabajado",
                                     "conceptoCodigo", "proveedorTextoNormalizado", periodo, "fechaPago", "cajaPago", origen, "esBloqueado")
        VALUES (${businessId}, ${branchDe.get(f.puntoDeVentaId)}::bigint, ${f.rowId}, NULL, ${cod}, ${nom}, ${c.fechaPago}::timestamp, ${c.codigo}, ${emp.nombre},
                ${c.tipo === 'sueldo' ? 'Liquidación (Lazarillo)' : 'Adelanto (Lazarillo)'}, ${f.importe}::numeric, ${f.importe}::numeric,
                ${cod}, ${normalizarProveedorTexto(emp.nombre)}, ${periodo}::timestamp, ${c.fechaPago}::timestamp, ${f.medio}, ${ORIGEN_LAZARILLO}, ${f.bloqueada})`);
    }
    await registrarActividad(tx, {
      organizationId, businessId, tipo: 'empleado', accion: 'creada', usuario, refId: `emp-${id}`,
      descripcion: `${nombreCompleto}\n${c.tipo === 'sueldo' ? 'Sueldo' : 'Adelanto'} ${c.periodo.slice(5)}/${c.periodo.slice(0, 4)} · ${pesos(total)}`,
    });
    return { id, libres: filas.filter((f) => !f.bloqueada).map((f) => f.rowId) };
  });

  // La carga ya quedó guardada: un fallo de estos dos pasos no la deshace, queda en el log.
  const ctx = { organizationId, businessId };
  await aplicarConceptosEmpleado(ctx, { branchId: lugar.branchId }).catch((err) => console.error('[gestion/empleados] concepto fijo', err));
  const apertura = await reaplicarReglasActivas(ctx, { rowIds: res.libres }).catch((err) => ({ errores: [String(err)] }));
  if (apertura.errores.length) console.error('[gestion/empleados] apertura', apertura.errores);
  return { ok: true, id: res.id, total };
}

// Anula un sueldo o adelanto de Lazarillo: borra sus filas (y lo repartido, en cascada) y deja la cabecera.
async function anularCarga({ organizationId, businessId, usuario, id }) {
  if (!Number.isInteger(id) || id <= 0) throw rechazo('Datos inválidos');
  const ok = await db.transaction(async (tx) => {
    const l = await tx.one(sql`
      SELECT tipo, "empleadoNombre", total::float8 AS total FROM gestion_liquidaciones_empleado
      WHERE id = ${id} AND business_id = ${businessId} AND "anuladoEn" IS NULL FOR UPDATE`);
    if (!l) return false;
    await tx.execute(sql`DELETE FROM gestion_compras WHERE business_id = ${businessId} AND origen = ${ORIGEN_LAZARILLO} AND "rowId" LIKE ${`emp-${id}-%`}`);
    await tx.execute(sql`UPDATE gestion_liquidaciones_empleado SET "anuladoEn" = CURRENT_TIMESTAMP, "anuladoPor" = ${usuario} WHERE id = ${id}`);
    await registrarActividad(tx, {
      organizationId, businessId, tipo: 'empleado', accion: 'eliminada', usuario, refId: `emp-${id}`,
      descripcion: `${l.empleadoNombre}\n${l.tipo === 'sueldo' ? 'Sueldo' : 'Adelanto'} anulado · ${pesos(l.total)}`,
    });
    return true;
  });
  if (!ok) throw rechazo('No se encontró (o ya estaba anulado)', 404);
  return { ok: true };
}

// Cuenta del empleado por período (últimos 12 meses).
async function obtenerCuenta({ organizationId, businessId, sp }) {
  const codigo = (sp.get('codigo') ?? '').trim();
  if (!codigo || codigo.length > 20) throw rechazo('Datos inválidos');
  const { lugar } = await lugarDelNegocio(db, businessId, Number(sp.get('pdvId')));
  const emp = await empleadoDe(db, businessId, lugar.branchId, codigo);
  if (!emp) throw rechazo('Ese empleado no está en la nómina de la sucursal', 404);
  const d = new Date();
  const desde = `${d.getFullYear() - 1}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  const [movs, adelanto, cargas] = await Promise.all([
    movimientosEmpleado(db, { organizationId, businessId, branchId: lugar.branchId, codigo, nombre: emp.nombre, desde }),
    conceptoAdelanto(db, organizationId),
    db.many(sql`
      SELECT id, tipo, to_char(periodo, 'YYYY-MM') AS periodo, to_char("fechaPago", 'YYYY-MM-DD') AS "fechaPago", total::float8 AS total, "creadoPor"
      FROM gestion_liquidaciones_empleado l
      WHERE ${enLugar('l', businessId, lugar.branchId)} AND "empleadoCodigo" = ${codigo} AND "anuladoEn" IS NULL AND periodo >= ${desde}::date
      ORDER BY "creadoEn" DESC`),
  ]);
  const codAdelanto = adelanto?.codigo ?? null;
  const periodos = new Map();
  for (const m of movs) {
    const p = periodos.get(m.periodo) ?? { periodo: m.periodo, adelantos: 0, sueldo: 0, movimientos: [] };
    if (m.cod === codAdelanto) p.adelantos += m.importe; else p.sueldo += m.importe;
    p.movimientos.push(m);
    periodos.set(m.periodo, p);
  }
  return { codigoAdelanto: codAdelanto, periodos: [...periodos.values()].sort((a, b) => b.periodo.localeCompare(a.periodo)), cargas };
}

// ── Concepto fijo por empleado ────────────────────────────────────────
// Todo lo cargado a nombre de un empleado va a un concepto. Idempotente: corre al guardar o quitar una
// regla y tras cada import. Escribe conceptoCodigoManual y marca conceptoPorRegla, para no pisar nunca
// lo que corrigió una persona (conceptoPorRegla NULL con manual) y poder deshacerlo.
async function reglasActivas(cliente, businessId, branchId) {
  const filas = await cliente.many(sql`
    SELECT r.id, r."entidadId", r.nombre, r.branch_id, r."conceptoCodigo", r.modo, r."fechaDesde", r."fechaHasta", r."extremosInclusivos"
    FROM gestion_reglas_concepto_empleado r
    WHERE r.business_id = ${businessId} AND r.estado = 'activa'
      ${branchId !== undefined ? sql`AND r.branch_id IS NOT DISTINCT FROM ${branchId}::bigint` : sql``}
    ORDER BY r.id`);
  return filas.map(({ branch_id, ...r }) => ({
    ...r,
    branchId: branch_id == null ? null : Number(branch_id),
    // superposicion() compara por origen: dentro del negocio, la sucursal alcanza.
    origenPuntoDeVentaId: branch_id == null ? 0 : Number(branch_id),
    fechaDesde: r.fechaDesde?.toISOString() ?? null,
    fechaHasta: r.fechaHasta?.toISOString() ?? null,
  }));
}

// "Esta compra es del empleado de la regla y cae en su período" (alias c).
function condicionRegla(businessId, r) {
  const ent = parsearEntidadIdProveedorTexto(r.entidadId);
  if (!ent) return null;
  const v = { modo: r.modo, fechaDesde: r.fechaDesde ? new Date(r.fechaDesde) : null, fechaHasta: r.fechaHasta ? new Date(r.fechaHasta) : null, extremosInclusivos: r.extremosInclusivos };
  return sql`c."proveedorId" IS NULL AND ${enLugar('c', businessId, r.branchId)}
    AND c."proveedorTextoNormalizado" = ${ent.normalizado}
    ${ent.codigo != null ? sql`AND c.codigo = ${ent.codigo}` : sql``}
    AND ${vigenciaToSql(resolverVigencia(v), FECHA_EFECTIVA_COMPRA_SQL)}`;
}

async function aplicarConceptosEmpleado({ organizationId, businessId }, opts = {}) {
  const reglas = await reglasActivas(db, businessId, opts.branchId);
  const cambiados = new Set();
  const errores = [];
  const filtroLugar = opts.branchId !== undefined ? sql`AND c.branch_id IS NOT DISTINCT FROM ${opts.branchId}::bigint` : sql``;
  const ids = reglas.map((r) => r.id);
  // 1) Deshacer lo que puso una regla que ya no está activa.
  const sueltos = await db.many(sql`
    UPDATE gestion_compras c SET "conceptoCodigoManual" = NULL, "conceptoPorRegla" = NULL
    WHERE c.business_id = ${businessId} AND c."conceptoPorRegla" IS NOT NULL ${filtroLugar}
      ${ids.length ? sql`AND c."conceptoPorRegla" <> ALL(${ids}::int[])` : sql``}
    RETURNING c."rowId"`);
  sueltos.forEach((f) => cambiados.add(f.rowId));
  for (const r of reglas) {
    const cond = condicionRegla(businessId, r);
    if (!cond) { errores.push(`Regla ${r.id}: empleado sin identificar (${r.entidadId})`); continue; }
    // 2) Deshacer los que puso esta regla y ya no le corresponden (cambió el período).
    const fuera = await db.many(sql`
      UPDATE gestion_compras c SET "conceptoCodigoManual" = NULL, "conceptoPorRegla" = NULL
      WHERE c.business_id = ${businessId} AND c."conceptoPorRegla" = ${r.id} AND NOT (${cond})
      RETURNING c."rowId"`);
    fuera.forEach((f) => cambiados.add(f.rowId));
    // 3) Aplicar a los suyos, salvo los corregidos a mano por una persona.
    const dentro = await db.many(sql`
      UPDATE gestion_compras c SET "conceptoCodigoManual" = ${r.conceptoCodigo}, "conceptoPorRegla" = ${r.id}
      WHERE ${cond}
        AND (c."conceptoCodigoManual" IS NULL OR c."conceptoPorRegla" IS NOT NULL)
        AND (c."conceptoPorRegla" IS DISTINCT FROM ${r.id} OR c."conceptoCodigoManual" IS DISTINCT FROM ${r.conceptoCodigo})
      RETURNING c."rowId"`);
    dentro.forEach((f) => cambiados.add(f.rowId));
  }
  // 4) Los que cambiaron de concepto y están (o quedarían) repartidos por una regla de concepto se reevalúan.
  let reevaluados = 0;
  if (cambiados.size) {
    const lista = [...cambiados];
    const areevaluar = await db.many(sql`
      SELECT c."rowId" FROM gestion_compras c
      WHERE c.business_id = ${businessId} AND c."rowId" = ANY(${lista}::text[])
        AND (EXISTS (SELECT 1 FROM gestion_distribuciones_apertura da JOIN gestion_reglas_apertura ra ON ra.id = da."reglaId"
                     WHERE da.compra_business_id = c.business_id AND da."compraRowId" = c."rowId" AND ra.nivel = 'concepto')
          OR EXISTS (SELECT 1 FROM gestion_reglas_apertura ra WHERE ra.organization_id = ${organizationId} AND ra.business_id = c.business_id
                     AND ra.estado = 'activa' AND ra.nivel = 'concepto' AND ra."entidadId" = COALESCE(c."conceptoCodigoManual", c."conceptoCodigo")))`);
    for (const { rowId } of areevaluar.slice(0, 300)) {
      try {
        await db.transaction((tx) => reevaluarCompra(tx, { organizationId, businessId }, rowId));
        reevaluados += 1;
      } catch (e) {
        errores.push(`Apertura ${rowId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (areevaluar.length > 300) errores.push(`Quedaron ${areevaluar.length - 300} registros sin reevaluar la apertura.`);
  }
  return { cambiados: cambiados.size, reevaluados, errores };
}

async function listarConceptosFijos({ organizationId, businessId, sp }) {
  const { lugar } = await lugarDelNegocio(db, businessId, Number(sp.get('pdvId')));
  const reglas = await reglasActivas(db, businessId, lugar.branchId);
  const cods = [...new Set(reglas.map((r) => r.conceptoCodigo))];
  const conceptos = cods.length ? await db.many(sql`SELECT codigo, nombre FROM gestion_conceptos_caja WHERE organization_id = ${organizationId} AND codigo = ANY(${cods}::text[])`) : [];
  const nombre = new Map(conceptos.map((c) => [c.codigo, c.nombre]));
  return { reglas: reglas.map((r) => ({ ...r, conceptoNombre: nombre.get(r.conceptoCodigo) ?? r.conceptoCodigo })) };
}

const fechaRegla = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().transform((v) => (v ? `${v}T00:00:00.000Z` : null));
const reglaSchema = z.object({
  id: z.number().int().positive().optional(),
  pdvId: z.number().int(),
  entidadId: z.string().startsWith('texto:').max(200),
  nombre: z.string().trim().max(120).optional().nullable(),
  conceptoCodigo: z.string().trim().min(1).max(20),
  modo: z.enum(['historico', 'entre_fechas', 'desde_adelante', 'desde_atras']),
  fechaDesde: fechaRegla,
  fechaHasta: fechaRegla,
  extremosInclusivos: z.boolean().default(true),
  previsualizar: z.boolean().optional(),
});

// Previsualiza (previsualizar: true) o guarda la regla y la aplica.
async function guardarConceptoFijo({ organizationId, businessId, usuario, body }) {
  const parsed = reglaSchema.safeParse(body);
  if (!parsed.success) throw rechazo('Datos inválidos', 400, detalleDe(parsed));
  const b = parsed.data;
  const { lugar } = await lugarDelNegocio(db, businessId, b.pdvId);
  const r = {
    id: b.id, entidadId: b.entidadId, branchId: lugar.branchId, origenPuntoDeVentaId: lugar.branchId ?? 0, conceptoCodigo: b.conceptoCodigo, modo: b.modo,
    fechaDesde: b.modo === 'desde_atras' || b.modo === 'historico' ? null : b.fechaDesde,
    fechaHasta: b.modo === 'desde_adelante' || b.modo === 'historico' ? null : b.fechaHasta,
    extremosInclusivos: b.modo === 'historico' ? true : b.extremosInclusivos,
  };
  const err = errorVigencia(r);
  if (err) throw rechazo(err);
  const concepto = await db.one(sql`SELECT codigo FROM gestion_conceptos_caja WHERE organization_id = ${organizationId} AND codigo = ${b.conceptoCodigo}`);
  if (!concepto) throw rechazo('Ese concepto no existe.');
  if (superposicion(r, await reglasActivas(db, businessId, lugar.branchId))) {
    throw rechazo('Ya hay otra regla de este empleado en ese período. Quitala o cambiá las fechas.', 409);
  }

  if (b.previsualizar) {
    const cond = condicionRegla(businessId, r);
    if (!cond) return { registros: 0, total: 0, conceptos: [] };
    const filas = await db.many(sql`
      SELECT COALESCE(cc.nombre, COALESCE(c."conceptoCodigoManual", c."conceptoCodigo"), 'Sin concepto') AS concepto,
             COUNT(*)::int AS n, SUM(COALESCE(c."importeManual", c.importe))::float8 AS total
      FROM gestion_compras c
      LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId} AND cc.codigo = COALESCE(c."conceptoCodigoManual", c."conceptoCodigo")
      WHERE ${cond}
        AND (c."conceptoCodigoManual" IS NULL OR c."conceptoPorRegla" IS NOT NULL)
        AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo", '') <> ${r.conceptoCodigo}
      GROUP BY 1 ORDER BY 3 DESC`);
    return { registros: filas.reduce((s, f) => s + f.n, 0), total: filas.reduce((s, f) => s + f.total, 0), conceptos: filas };
  }

  if (b.id) {
    await db.execute(sql`
      UPDATE gestion_reglas_concepto_empleado SET "conceptoCodigo" = ${r.conceptoCodigo}, modo = ${r.modo}, "fechaDesde" = ${r.fechaDesde}::timestamp,
        "fechaHasta" = ${r.fechaHasta}::timestamp, "extremosInclusivos" = ${r.extremosInclusivos}, nombre = COALESCE(${b.nombre ?? null}, nombre)
      WHERE id = ${b.id} AND estado = 'activa' AND business_id = ${businessId} AND branch_id IS NOT DISTINCT FROM ${lugar.branchId}::bigint`);
  } else {
    await db.execute(sql`
      INSERT INTO gestion_reglas_concepto_empleado (business_id, branch_id, "entidadId", nombre, "conceptoCodigo", modo, "fechaDesde", "fechaHasta", "extremosInclusivos", "creadoPor")
      VALUES (${businessId}, ${lugar.branchId}::bigint, ${r.entidadId}, ${b.nombre ?? null}, ${r.conceptoCodigo}, ${r.modo}, ${r.fechaDesde}::timestamp, ${r.fechaHasta}::timestamp, ${r.extremosInclusivos}, ${usuario})`);
  }
  return { ok: true, ...(await aplicarConceptosEmpleado({ organizationId, businessId }, { branchId: lugar.branchId })) };
}

// Quita la regla (queda inactiva) y vuelve los registros a su concepto original.
async function quitarConceptoFijo({ organizationId, businessId, sp }) {
  const id = Number(sp.get('id'));
  if (!Number.isInteger(id) || id <= 0) throw rechazo('Datos inválidos');
  const { lugar } = await lugarDelNegocio(db, businessId, Number(sp.get('pdvId')));
  await db.execute(sql`
    UPDATE gestion_reglas_concepto_empleado SET estado = 'inactiva'
    WHERE id = ${id} AND business_id = ${businessId} AND branch_id IS NOT DISTINCT FROM ${lugar.branchId}::bigint`);
  return { ok: true, ...(await aplicarConceptosEmpleado({ organizationId, businessId }, { branchId: lugar.branchId })) };
}

module.exports = {
  obtenerNomina, crearCarga, anularCarga, obtenerCuenta,
  listarConceptosFijos, guardarConceptoFijo, quitarConceptoFijo, aplicarConceptosEmpleado,
};
