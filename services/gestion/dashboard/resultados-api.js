// Endpoints del paso 3 del Panel (Resultados, tarjetas KPI y el bloque Operación), portados de
// lazarillo_gestion/app/api/dashboard/{proyeccion,equilibrio,equilibrio/variables,flujo-caja,
// diferencia-caja,canasta,canasta/aumentos,actualizado,rango-anios}/route.ts. Misma lógica; las
// rutas HTTP viven en routes/gestionRoutes.js.
//
// Traducción de tenancy (igual que pivot.js):
//   - local / PDV de gestion → negocio activo + sucursal opcional (undefined = todas,
//     null = la principal, número = esa sucursal), con filtroSucursalSql / buildPivotConditions.
//   - maestros (conceptos, rubros) → de la organización; visibilidad de rubros → del negocio.
//   - equilibrio_variables → por negocio; flujo_caja_manual / aumentos_precio → negocio + sucursal.
'use strict';

const { sql, db } = require('../db');
const { buildPivotConditions, filtroSucursalSql, rangoAnio } = require('./query-builders');
const { fuenteCompras } = require('./fuente-compras');
const { toNumber } = require('./pivot-utils');
const { MONTH_IDXS } = require('./constants');
const { proyectarMes, debeProyectar, METODOS } = require('./proyeccion');
const { cambioValido } = require('./equilibrio-config');
const { aggregateFlujoCajaPorMes } = require('./flujo-caja-agg');
const { findPrimerArqueo } = require('./primer-arqueo');
const { buildDiferenciaCajaSerie } = require('./diferencia-caja-serie');
const { mesesHasta } = require('./canasta');
const { resolveAnioRange } = require('./anio-range');

class ErrorDatos extends Error {
  constructor(message) { super(message); this.status = 400; }
}

// Conceptos y rubros de la organización + visibilidad de rubros del negocio (alias cc / rc / rv,
// los que esperan buildPivotConditions y los filtros de visibilidad). `col` = columna de la fila
// de compras con el concepto efectivo.
const joinsConcepto = ({ organizationId, businessId }, t = "c") => sql`
  LEFT JOIN gestion_conceptos_caja cc       ON cc.organization_id = ${organizationId}
                                            AND COALESCE(${sql.raw(t)}."conceptoCodigoManual", ${sql.raw(t)}."conceptoCodigo") = cc.codigo
  LEFT JOIN gestion_rubros_concepto_caja rc ON rc.organization_id = ${organizationId} AND cc."codRga" = rc.codigo
  LEFT JOIN gestion_rubros_visibilidad rv   ON rv.business_id = ${businessId} AND rv.codigo = rc.codigo`;

// Ámbito con el que se guardan las proyecciones (en gestion: "<local>/<pdv>").
const ambitoDe = (sucursal) => (sucursal === undefined ? "*" : sucursal === null ? "principal" : String(sucursal));

// ---------------------------------------------------------------- proyeccion
// Proyección de cierre del mes con ventas incompletas (tooltip de Ingresos).
// Mismos filtros que pivot-ventas (negocio/sucursal), sin filtro de meses.
async function obtenerProyeccion({ businessId, params }) {
  const { year, sucursal } = params;
  const base = buildPivotConditions({ tableAlias: "v", hasFechaManual: false, businessId, sucursal });

  const ult = await db.one(sql`
    SELECT to_char(MAX(v.fecha)::date, 'YYYY-MM-DD') AS ultimo
    FROM gestion_ventas v
    WHERE ${sql.join([...base, rangoAnio(sql`v.fecha`, year)], " AND ")}
  `);
  const ultimo = ult?.ultimo ?? null;
  // "Hoy" en Argentina (UTC-3).
  const hoy = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
  if (!ultimo || !debeProyectar(ultimo, hoy)) return { proyeccion: null };

  // Dos años y dos meses para atrás: estacionalidad de los 2 años anteriores (cada uno con su
  // ventana de 8 semanas), backtest de 6 meses y comparación con el año anterior.
  const [uy, um] = ultimo.split("-").map(Number);
  const desde = new Date(Date.UTC(uy - 2, um - 3, 1)).toISOString().slice(0, 10);

  const rows = await db.many(sql`
    SELECT to_char(v.fecha::date, 'YYYY-MM-DD') AS fecha,
           SUM(COALESCE(v."importeManual", v.importe)) AS total
    FROM gestion_ventas v
    WHERE ${sql.join([
      ...base,
      // Rangos sobre v.fecha (no v.fecha::date) para que use el índice (Diego 29/10/2026).
      sql`v.fecha >= ${desde}::timestamp`,
      sql`v.fecha < ${ultimo}::date + 1`,
    ], " AND ")}
    GROUP BY 1
    ORDER BY 1
  `);

  // Proyecciones guardadas de este negocio/sucursal (para medir qué método erró menos).
  const ambito = ambitoDe(sucursal);
  const guardadas = await db.many(sql`
    SELECT anio, mes, metodo, proyeccion FROM gestion_proyecciones_ingresos
    WHERE business_id = ${businessId} AND ambito = ${ambito} AND corte >= ${desde}::date
  `).catch((err) => {
    console.error("No se pudieron leer las proyecciones guardadas", err);
    return [];
  });

  const proyeccion = proyectarMes(
    rows.map((r) => ({ fecha: r.fecha, total: toNumber(r.total) })),
    ultimo,
    guardadas.map((g) => ({ anio: g.anio, mes: g.mes, metodo: g.metodo, proyeccion: toNumber(g.proyeccion) })),
  );

  // Se guarda la de hoy (los dos métodos). Mismo corte = se actualiza, no se duplica.
  if (proyeccion) {
    try {
      const branchId = typeof sucursal === "number" ? sucursal : null;
      for (const metodo of METODOS) {
        await db.execute(sql`
          INSERT INTO gestion_proyecciones_ingresos (business_id, branch_id, ambito, anio, mes, corte, metodo, facturado, proyeccion)
          VALUES (${businessId}, ${branchId}, ${ambito}, ${proyeccion.anio}, ${proyeccion.mes}, ${ultimo}::date, ${metodo},
                  ${Math.round(proyeccion.facturado * 100) / 100}, ${Math.round(proyeccion.proyecciones[metodo] * 100) / 100})
          ON CONFLICT (business_id, ambito, anio, mes, corte, metodo)
          DO UPDATE SET facturado = EXCLUDED.facturado, proyeccion = EXCLUDED.proyeccion, "creadoEn" = now()
        `);
      }
    } catch (err) {
      console.error("No se pudo guardar la proyección", err); // no frena el tooltip
    }
  }
  return { proyeccion };
}

// ---------------------------------------------------------------- equilibrio
// Gastos VARIABLES por mes para el punto de equilibrio (Diego 30/10/2026), con los mismos filtros
// que la fila Egresos del tablero (vista Económica, rubros visibles).
// Variable = importe × % de equilibrio_variables (el del concepto manda sobre el de su rubro).
async function obtenerEquilibrio({ organizationId, businessId, year, sucursal }) {
  if (!year) throw new ErrorDatos("Datos inválidos");
  const cond = sql.join(buildPivotConditions({ year, tableAlias: "c", businessId, sucursal, filterRubrosOcultos: true }), " AND ");
  const filas = await db.many(sql`
    SELECT EXTRACT(MONTH FROM COALESCE(c."fechaManual", c.fecha))::int AS mes,
           TRIM(CASE WHEN vc.pct IS NOT NULL THEN cc.nombre ELSE rc.nombre END) AS nombre,
           SUM(COALESCE(c."importeManual", c.importe) * COALESCE(vc.pct, vr.pct) / 100)::float8 AS total
    FROM ${fuenteCompras(undefined)} c
    ${joinsConcepto({ organizationId, businessId })}
    LEFT JOIN gestion_equilibrio_variables vc ON vc.business_id = ${businessId} AND vc.tipo = 'concepto' AND vc.codigo = cc.codigo
    LEFT JOIN gestion_equilibrio_variables vr ON vr.business_id = ${businessId} AND vr.tipo = 'rubro' AND vr.codigo = rc.codigo
    WHERE ${cond} AND COALESCE(vc.pct, vr.pct) > 0
    GROUP BY 1, 2`);
  const variables = await db.many(sql`
    SELECT v.tipo, TRIM(COALESCE(rc.nombre, cc.nombre, v.codigo)) AS nombre, v.pct::float8 AS pct
    FROM gestion_equilibrio_variables v
    LEFT JOIN gestion_rubros_concepto_caja rc ON v.tipo = 'rubro' AND rc.organization_id = ${organizationId} AND rc.codigo = v.codigo
    LEFT JOIN gestion_conceptos_caja cc       ON v.tipo = 'concepto' AND cc.organization_id = ${organizationId} AND cc.codigo = v.codigo
    WHERE v.business_id = ${businessId} AND v.pct > 0 ORDER BY v.tipo DESC, 2`);

  const porMes = {};
  for (const f of filas) {
    const m = (porMes[f.mes] ??= { total: 0, detalle: [] });
    m.total += Number(f.total);
    m.detalle.push({ nombre: f.nombre, total: Number(f.total) });
  }
  for (const m of Object.values(porMes)) m.detalle.sort((a, b) => b.total - a.total);
  return { porMes, variables };
}

const MESES_PROMEDIO = 6;

// Configuración de gastos variables del punto de equilibrio (Diego 30/10/2026).
// Con anio+mes (mes de referencia, el último cerrado) suma además lo gastado por concepto ese mes y
// el promedio de los 6 meses que terminan en él, con los filtros de la fila Egresos (Económica,
// rubros visibles, negocio/sucursal): es lo que muestra el ⚙ de la fila para ver el antes → después.
async function obtenerEquilibrioVariables({ organizationId, businessId, anio, mes, sucursal }) {
  const variables = await db.many(sql`
    SELECT tipo, TRIM(codigo) AS codigo, pct::float8 AS pct FROM gestion_equilibrio_variables
    WHERE business_id = ${businessId} ORDER BY tipo, codigo`);
  if (!anio || !mes || mes > 12) return { variables };

  const ref = new Date(Date.UTC(anio, mes - 1, 1));
  const desde = new Date(Date.UTC(anio, mes - MESES_PROMEDIO, 1));
  const hasta = new Date(Date.UTC(anio, mes, 1));
  const iso = (d) => d.toISOString().slice(0, 10);
  const fecha = sql`COALESCE(c."fechaManual", c.fecha)`;
  const imp = sql`COALESCE(c."importeManual", c.importe)`;
  const cond = sql.join(buildPivotConditions({ tableAlias: "c", businessId, sucursal, filterRubrosOcultos: true }), " AND ");
  const gastos = await db.many(sql`
    SELECT TRIM(rc.codigo) AS "rubroCodigo", TRIM(COALESCE(rc.nombre, 'Sin rubro')) AS rubro,
           TRIM(cc.codigo) AS codigo, TRIM(cc.nombre) AS nombre,
           (SUM(${imp}) / ${MESES_PROMEDIO})::float8 AS prom,
           COALESCE(SUM(${imp}) FILTER (WHERE ${fecha} >= ${iso(ref)}::timestamp), 0)::float8 AS mes
    FROM ${fuenteCompras(undefined)} c
    JOIN gestion_conceptos_caja cc            ON cc.organization_id = ${organizationId}
                                              AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = cc.codigo
    LEFT JOIN gestion_rubros_concepto_caja rc ON rc.organization_id = ${organizationId} AND cc."codRga" = rc.codigo
    LEFT JOIN gestion_rubros_visibilidad rv   ON rv.business_id = ${businessId} AND rv.codigo = rc.codigo
    WHERE ${cond} AND ${fecha} >= ${iso(desde)}::timestamp AND ${fecha} < ${iso(hasta)}::timestamp
    GROUP BY 1, 2, 3, 4
    ORDER BY prom DESC`);
  return { variables, gastos };
}

// cambios: [{ tipo, codigo, pct | null }] — todo junto o nada. pct null = sin marca (hereda
// del rubro, o fijo si es un rubro). Un concepto con 0 queda fijo aunque su rubro sea variable.
async function guardarEquilibrioVariables({ organizationId, businessId, body }) {
  const cambios = Array.isArray(body?.cambios) ? body.cambios : null;
  if (!cambios || cambios.length === 0 || cambios.length > 500 || !cambios.every(cambioValido)) {
    throw new ErrorDatos("Datos inválidos");
  }
  const lista = cambios.map((c) => ({ ...c, codigo: c.codigo.trim() }));

  // Solo códigos que existen en los maestros de la organización (no se guardan marcas huérfanas).
  const rubros = lista.filter((c) => c.tipo === "rubro").map((c) => c.codigo);
  const conceptos = lista.filter((c) => c.tipo === "concepto").map((c) => c.codigo);
  const [rOk, cOk] = await Promise.all([
    rubros.length ? db.many(sql`SELECT TRIM(codigo) AS c FROM gestion_rubros_concepto_caja WHERE organization_id = ${organizationId} AND TRIM(codigo) = ANY(${rubros})`) : [],
    conceptos.length ? db.many(sql`SELECT TRIM(codigo) AS c FROM gestion_conceptos_caja WHERE organization_id = ${organizationId} AND TRIM(codigo) = ANY(${conceptos})`) : [],
  ]);
  const existe = new Set([...rOk.map((r) => `rubro:${r.c}`), ...cOk.map((r) => `concepto:${r.c}`)]);
  const faltan = lista.filter((c) => !existe.has(`${c.tipo}:${c.codigo}`));
  if (faltan.length) throw new ErrorDatos(`No existe: ${faltan.map((f) => `${f.tipo} ${f.codigo}`).join(", ")}`);

  await db.transaction(async (tx) => {
    for (const c of lista) {
      if (c.pct == null) {
        await tx.execute(sql`DELETE FROM gestion_equilibrio_variables WHERE business_id = ${businessId} AND tipo = ${c.tipo} AND TRIM(codigo) = ${c.codigo}`);
      } else {
        await tx.execute(sql`INSERT INTO gestion_equilibrio_variables (business_id, tipo, codigo, pct) VALUES (${businessId}, ${c.tipo}, ${c.codigo}, ${c.pct})
          ON CONFLICT (business_id, tipo, codigo) DO UPDATE SET pct = EXCLUDED.pct`);
      }
    }
  });
  return { ok: true, guardados: lista.length };
}

// ---------------------------------------------------------------- flujo de caja (arqueos)
// Disponible en caja por mes. En gestion se priorizaba la fila "todo el local" sobre la suma de
// PDVs; en Lazarillo cada arqueo es de una sucursal concreta (NULL = la principal), así que
// "todas" es la suma directa (aggregateFlujoCajaPorMes con un PDV puntual = suma sin niveles).
async function disponiblePorMes({ businessId, anio, sucursal }) {
  const rows = await db.many(sql`
    SELECT f.mes, f.monto FROM gestion_flujo_caja_manual f
    WHERE ${filtroSucursalSql("f", businessId, sucursal)} AND f.anio = ${anio} AND f.monto <> 0
  `);
  return aggregateFlujoCajaPorMes(
    rows.map((r) => ({ localId: null, puntoDeVentaId: null, mes: r.mes, monto: Number(r.monto) })),
    "suma",
  );
}

async function obtenerFlujoCaja({ businessId, anio, sucursal }) {
  if (!Number.isInteger(anio)) throw new ErrorDatos("Falta anio");
  return { anio, meses: await disponiblePorMes({ businessId, anio, sucursal }) };
}

// body { anio, mes, monto }; la sucursal sale del filtro (undefined = todas no se puede cargar:
// el arqueo es de una caja concreta).
async function guardarFlujoCaja({ businessId, sucursal, body }) {
  const anio = body?.anio, mes = body?.mes, monto = body?.monto;
  const valido = Number.isInteger(anio) && anio >= 2000 && anio <= 2100
    && Number.isInteger(mes) && mes >= 1 && mes <= 12
    && typeof monto === "number" && Number.isFinite(monto);
  if (!valido || sucursal === undefined) throw new ErrorDatos("Invalid body");
  // Un monto en 0 significa "sin dato" (ver spec 2026-08-31): se borra la fila en vez de
  // guardar un $0 que después no se puede limpiar. Borrar una fila inexistente es no-op.
  if (monto === 0) {
    await db.execute(sql`
      DELETE FROM gestion_flujo_caja_manual
      WHERE business_id = ${businessId} AND branch_id IS NOT DISTINCT FROM ${sucursal}::bigint
        AND anio = ${anio} AND mes = ${mes}
    `);
    return { ok: true };
  }
  // Índice único (business_id, branch_id, anio, mes) NULLS NOT DISTINCT: ON CONFLICT también
  // matchea la principal (branch_id NULL).
  await db.execute(sql`
    INSERT INTO gestion_flujo_caja_manual (business_id, branch_id, anio, mes, monto)
    VALUES (${businessId}, ${sucursal}::bigint, ${anio}, ${mes}, ${monto})
    ON CONFLICT (business_id, branch_id, anio, mes)
    DO UPDATE SET monto = EXCLUDED.monto
  `);
  return { ok: true };
}

// ---------------------------------------------------------------- diferencia de caja
function diferenciaVacia() {
  const vacio = {};
  for (const mes of MONTH_IDXS) vacio[mes] = { valor: null, acumulado: null };
  return vacio;
}

// Suma mensual de compras para una vista de visibilidad: el columnTotals del pivot, con GROUP BY.
async function sumComprasPorMes({ organizationId, businessId, anio, sucursal, visibilidadCol }) {
  const where = sql.join(buildPivotConditions({
    year: anio, tableAlias: "c", businessId, sucursal, filterRubrosOcultos: true, visibilidadCol,
  }), " AND ");
  const rows = await db.many(sql`
    SELECT
      EXTRACT(MONTH FROM COALESCE(c."fechaManual", c.fecha))::int AS mes,
      SUM(COALESCE(c."importeManual", c.importe))                 AS total
    FROM gestion_v_compras_distribuidas c
    ${joinsConcepto({ organizationId, businessId })}
    WHERE ${where}
    GROUP BY 1
  `);
  const out = {};
  for (const r of rows) out[r.mes] = toNumber(r.total ?? 0);
  return out;
}

// Suma mensual de ventas. Mismo WHERE base que pivot-ventas.
async function sumVentasPorMes({ businessId, anio, sucursal }) {
  const where = sql.join(buildPivotConditions({ year: anio, tableAlias: "v", hasFechaManual: false, businessId, sucursal }), " AND ");
  const rows = await db.many(sql`
    SELECT
      EXTRACT(MONTH FROM v.fecha)::int            AS mes,
      SUM(COALESCE(v."importeManual", v.importe)) AS total
    FROM gestion_ventas v
    WHERE ${where}
    GROUP BY 1
  `);
  const out = {};
  for (const r of rows) out[r.mes] = toNumber(r.total ?? 0);
  return out;
}

async function obtenerDiferenciaCaja({ organizationId, businessId, year, sucursal }) {
  if (!Number.isInteger(year)) throw new ErrorDatos("Parámetros inválidos");
  // Guarda de fan-out: cada año en [primerArqueo.anio .. year] cuesta 4 queries. Fuera de
  // rango → los 12 meses en null (spec §3.1), nunca 400.
  if (year < 2000 || year > new Date().getFullYear() + 1) return { diferenciaPorMes: diferenciaVacia() };

  const primerArqueo = await findPrimerArqueo({ businessId, sucursal });
  if (primerArqueo == null || primerArqueo.anio > year) return { diferenciaPorMes: diferenciaVacia() };

  const anios = [];
  for (let a = primerArqueo.anio; a <= year; a++) anios.push(a);

  const totalesPorAnio = {};
  await Promise.all(anios.map(async (anio) => {
    const o = { organizationId, businessId, anio, sucursal };
    const [ingresosPorMes, egresosPorMes, gananciaPorMes, disponible] = await Promise.all([
      sumVentasPorMes(o),
      sumComprasPorMes({ ...o, visibilidadCol: "visibleEnDashboard" }),
      sumComprasPorMes({ ...o, visibilidadCol: "visibleEnResultados" }),
      disponiblePorMes(o),
    ]);
    totalesPorAnio[anio] = { ingresosPorMes, egresosPorMes, gananciaPorMes, disponiblePorMes: disponible };
  }));

  return { diferenciaPorMes: buildDiferenciaCajaSerie({ year, primerArqueo, totalesPorAnio }) };
}

// ---------------------------------------------------------------- canasta
// Rubros estándar de MaxiRest (mismos códigos en todas las organizaciones).
const RUBRO = { mercaderias: "1", servicios: "2", personal: "3", alquiler: "21" };
const N = 13; // 12 variaciones: hacen falta 13 meses

// Los aumentos de la carta son de una caja concreta: con "todas" las sucursales, si al negocio
// no le entra nada de otra sucursal que la principal (gestion_render_origenes), son los de la
// principal; si sí, no hay un único juego de aumentos (gestion tampoco los mostraba sin PDV elegido).
async function sucursalDeAumentos(businessId, sucursal) {
  if (sucursal !== undefined) return sucursal;
  const r = await db.one(sql`SELECT COUNT(*)::int AS n FROM gestion_render_origenes WHERE business_id = ${businessId} AND branch_id IS NOT NULL`);
  return r && r.n === 0 ? null : undefined;
}

// Canasta (inflación propia) de los 12 meses que terminan en anio/mes (el último mes cerrado),
// con aperturas aplicadas (v_compras_distribuidas). Ver canasta.js.
async function obtenerCanasta({ organizationId, businessId, anio, mes, sucursal }) {
  if (!anio || !mes || mes > 12) throw new ErrorDatos("Datos inválidos");

  const meses = mesesHasta(anio, mes, N);
  const desde = `${meses[0]}-01`;
  const finRef = new Date(Date.UTC(anio, mes, 1)).toISOString().slice(0, 10);
  const desdePeso = `${meses[N - 6]}-01`;
  const fecha = sql`COALESCE(v."fechaManual", v.periodo, v.fecha)`;
  const imp = sql`COALESCE(v."importeManual", v.importe)`;
  const lugar = filtroSucursalSql("v", businessId, sucursal);
  const rango = sql`${fecha} >= ${desde}::timestamp AND ${fecha} < ${finRef}::timestamp`;
  // Precio de un insumo = mes de la FACTURA, no la fecha del renglón del 25 (en MaxiRest es la de carga y
  // en Lazarillo la de factura). Regla del proyecto: la fecha vive en el comprobante (Diego 30/10/2026).
  const fFactura = sql`COALESCE(c."fechaManual", c.fecha)`;
  const cc = sql`gestion_conceptos_caja cc`;
  const concepto = sql`cc.organization_id = ${organizationId} AND cc.codigo = COALESCE(v."conceptoCodigoManual", v."conceptoCodigo")`;
  const mesDe = (e) => sql`to_char(date_trunc('month', ${e}), 'YYYY-MM')`;
  const anterior = (a) => sql`to_char(to_date(${sql.raw(a)}, 'YYYY-MM') - interval '1 month', 'YYYY-MM')`;
  const sucAumentos = await sucursalDeAumentos(businessId, sucursal);

  const [merc, sue, serv, alq, pesos, aumentos] = await Promise.all([
    // Mercaderías: Laspeyres por insumo (cantidades del mes anterior), saltos raros aparte.
    db.many(sql`
      WITH comp AS (SELECT DISTINCT v."rowId" FROM gestion_v_compras_distribuidas v WHERE ${lugar} AND ${rango}),
      l AS (
        SELECT ${mesDe(fFactura)} AS m, d.codigo || '|' || COALESCE(UPPER(TRIM(d.medida)), '') AS k,
               SUM(d.cantidad) AS q, SUM(d.neto) AS val
        FROM gestion_detalle_compras d
        JOIN gestion_compras c ON c."rowId" = d."compraId"
        JOIN comp ON comp."rowId" = c."rowId"
        JOIN ${cc} ON cc.organization_id = ${organizationId}
                  AND cc.codigo = COALESCE(d."codCga", c."conceptoCodigoManual", c."conceptoCodigo")
        WHERE cc."codRga" = ${RUBRO.mercaderias} AND ${fFactura} >= ${desde}::timestamp AND ${fFactura} < ${finRef}::timestamp
          AND d.cantidad > 0 AND d.neto > 0 AND d.codigo IS NOT NULL
        GROUP BY 1, 2),
      p AS (SELECT m, k, q, val / q AS pr FROM l),
      par AS (SELECT a.m, a.pr AS pa, b.pr AS pb, b.q AS qb, (a.pr / b.pr BETWEEN 0.667 AND 1.5) AS ok
              FROM p a JOIN p b ON b.k = a.k AND b.m = ${anterior("a.m")})
      SELECT m, (SUM(qb * pa) FILTER (WHERE ok) / NULLIF(SUM(qb * pb) FILTER (WHERE ok), 0) - 1)::float8 AS v,
             (COUNT(*) FILTER (WHERE NOT ok))::int AS revisar
      FROM par GROUP BY m`),
    // Sueldos: mediana de la variación del mismo empleado (liquidación de sueldo + presentismo).
    db.many(sql`
      WITH e AS (
        SELECT ${mesDe(fecha)} AS m, v.codigo AS emp, SUM(${imp}) AS s
        FROM gestion_v_compras_distribuidas v
        JOIN ${cc} ON ${concepto}
        JOIN gestion_empleados em ON em.codigo = v.codigo AND em.business_id = v.business_id_origen
                                 AND em.branch_id IS NOT DISTINCT FROM v.branch_id_origen
        WHERE ${lugar} AND ${rango} AND cc."codRga" = ${RUBRO.personal}
          AND cc.nombre ~* '(liquidaci.*sueldo|presentismo)' AND cc.nombre !~* '(sac|final)'
        GROUP BY 1, 2 HAVING SUM(${imp}) > 0)
      SELECT a.m, (exp(percentile_cont(0.5) WITHIN GROUP (ORDER BY ln(a.s / b.s))) - 1)::float8 AS v
      FROM e a JOIN e b ON b.emp = a.emp AND b.m = ${anterior("a.m")}
      WHERE a.s / b.s BETWEEN 0.5 AND 2 GROUP BY a.m HAVING COUNT(*) >= 3`),
    // Servicios: mediana de la variación de cada proveedor × concepto.
    db.many(sql`
      WITH s AS (
        SELECT ${mesDe(fecha)} AS m, COALESCE(v.codigo, '') || '|' || cc.codigo AS k, SUM(${imp}) AS val
        FROM gestion_v_compras_distribuidas v JOIN ${cc} ON ${concepto}
        WHERE ${lugar} AND ${rango} AND cc."codRga" = ${RUBRO.servicios}
        GROUP BY 1, 2 HAVING SUM(${imp}) > 0)
      SELECT a.m, (exp(percentile_cont(0.5) WITHIN GROUP (ORDER BY ln(a.val / b.val))) - 1)::float8 AS v
      FROM s a JOIN s b ON b.k = a.k AND b.m = ${anterior("a.m")}
      WHERE a.val / b.val BETWEEN 0.667 AND 1.5 GROUP BY a.m HAVING COUNT(*) >= 2`),
    // Alquiler: el monto del mes (en revisión: se muestra, no entra a la canasta).
    db.many(sql`
      SELECT ${mesDe(fecha)} AS m, SUM(${imp})::float8 AS total
      FROM gestion_v_compras_distribuidas v JOIN ${cc} ON ${concepto}
      WHERE ${lugar} AND ${rango} AND cc."codRga" = ${RUBRO.alquiler}
      GROUP BY 1`),
    // Pesos: gasto de cada rubro en los últimos 6 meses.
    db.many(sql`
      SELECT cc."codRga" AS r, SUM(${imp})::float8 AS total
      FROM gestion_v_compras_distribuidas v JOIN ${cc} ON ${concepto}
      WHERE ${lugar} AND ${fecha} >= ${desdePeso}::timestamp AND ${fecha} < ${finRef}::timestamp
        AND cc."codRga" IN (${RUBRO.mercaderias}, ${RUBRO.servicios}, ${RUBRO.personal}, ${RUBRO.alquiler})
      GROUP BY 1`),
    sucAumentos !== undefined
      ? db.many(sql`
          SELECT a.fecha::text AS fecha, a.origen, a.pct::float8 AS pct, a.provisorio, a.detalle
          FROM gestion_aumentos_precio a
          WHERE ${filtroSucursalSql("a", businessId, sucAumentos)} AND NOT a.descartado ORDER BY a.fecha`)
      : Promise.resolve([]),
  ]);

  const serie = (filas) => {
    const map = new Map(filas.map((f) => [f.m, f.v == null ? null : Number(f.v)]));
    return meses.slice(1).map((m) => map.get(m) ?? null);
  };
  const alqMap = new Map(alq.map((a) => [a.m, Number(a.total)]));
  const alqVar = meses.slice(1).map((m, i) => {
    const a = alqMap.get(m), b = alqMap.get(meses[i]);
    return a != null && b != null && b > 0 ? a / b - 1 : null;
  });
  const peso = (r) => Number(pesos.find((p) => p.r === r)?.total ?? 0);
  const componentes = [
    { clave: "sueldos", nombre: "Sueldos", peso: peso(RUBRO.personal), variaciones: serie(sue), cuenta: true },
    { clave: "mercaderias", nombre: "Mercaderías", peso: peso(RUBRO.mercaderias), variaciones: serie(merc), cuenta: true,
      aRevisar: merc.find((x) => x.m === meses[N - 1])?.revisar ?? 0 },
    { clave: "servicios", nombre: "Servicios", peso: peso(RUBRO.servicios), variaciones: serie(serv), cuenta: true },
    { clave: "alquiler", nombre: "Alquiler", peso: peso(RUBRO.alquiler), variaciones: alqVar, cuenta: false },
  ].filter((c) => c.peso > 0);

  return { meses: meses.slice(1), componentes, aumentos };
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
function leerAumento(body, sucursal) {
  const fecha = String(body?.fecha ?? "");
  if (sucursal === undefined || !FECHA.test(fecha) || Number.isNaN(Date.parse(fecha))) return null;
  return { fecha };
}

// Anota un aumento de precios de la carta (sin duplicar). Si era uno detectado y descartado, vuelve a valer.
async function anotarAumento({ businessId, sucursal, body }) {
  const suc = await sucursalDeAumentos(businessId, sucursal);
  const d = leerAumento(body, suc);
  if (!d) throw new ErrorDatos("Datos inválidos");
  await db.execute(sql`
    INSERT INTO gestion_aumentos_precio (business_id, branch_id, fecha, origen)
    VALUES (${businessId}, ${suc}::bigint, ${d.fecha}::date, 'manual')
    ON CONFLICT (business_id, branch_id, fecha) DO UPDATE SET descartado = false`);
  return { ok: true };
}

// Saca un aumento mal anotado (o mal detectado). Uno detectado se marca descartado (si se borrara,
// la próxima detección lo volvería a agregar).
async function borrarAumento({ businessId, sucursal, body }) {
  const suc = await sucursalDeAumentos(businessId, sucursal);
  const d = leerAumento(body, suc);
  if (!d) throw new ErrorDatos("Datos inválidos");
  const donde = sql`business_id = ${businessId} AND branch_id IS NOT DISTINCT FROM ${suc}::bigint AND fecha = ${d.fecha}::date`;
  await db.execute(sql`UPDATE gestion_aumentos_precio SET descartado = true WHERE ${donde} AND origen = 'detectado'`);
  await db.execute(sql`DELETE FROM gestion_aumentos_precio WHERE ${donde} AND origen = 'manual'`);
  return { ok: true };
}

// ---------------------------------------------------------------- actualizado / rango de años
// "Actualizado al …" del encabezado del panel (Diego, 24/10/2026): último día con ventas y con
// compras del negocio/sucursal, y cuándo fue la última importación que salió bien.
async function obtenerActualizado({ businessId, sucursal }) {
  const filtro = (alias) => sql`${sql.raw(alias)}.fecha <= now() + interval '1 day' AND ${filtroSucursalSql(alias, businessId, sucursal)}`;
  const r = await db.one(sql`
    SELECT
      -- MAX(fecha)::date y no MAX(fecha::date): así sale del índice al toque (6 s → 10 ms, 29/10/2026).
      (SELECT to_char(MAX(v.fecha)::date, 'YYYY-MM-DD') FROM gestion_ventas v WHERE ${filtro("v")}) AS ventas,
      (SELECT to_char(MAX(c.fecha)::date, 'YYYY-MM-DD') FROM gestion_compras c WHERE ${filtro("c")}) AS compras,
      (SELECT MAX("creadoEn") FROM gestion_import_logs WHERE estado = 'ok' AND business_id = ${businessId}) AS importado
  `);
  return {
    ventas: r?.ventas ?? null,
    compras: r?.compras ?? null,
    importado: r?.importado ? new Date(r.importado).toISOString() : null,
  };
}

async function obtenerRangoAnios({ businessId, sucursal }) {
  const fc = filtroSucursalSql("c", businessId, sucursal);
  const fv = filtroSucursalSql("v", businessId, sucursal);
  // COALESCE(fechaManual, fecha) en compras — un override manual de fecha puede mover la fila a
  // otro año. MIN/MAX directo sobre la fecha: sale de los índices de fecha (29/10/2026).
  const row = await db.one(sql`
    SELECT EXTRACT(YEAR FROM LEAST(t.c_min, t.v_min))::int    AS "minYear",
           EXTRACT(YEAR FROM GREATEST(t.c_max, t.v_max))::int AS "maxYear"
    FROM (
      SELECT
        (SELECT MIN(COALESCE(c."fechaManual", c.fecha)) FROM gestion_compras c WHERE ${fc}) AS c_min,
        (SELECT MAX(COALESCE(c."fechaManual", c.fecha)) FROM gestion_compras c WHERE ${fc}) AS c_max,
        (SELECT MIN(v.fecha) FROM gestion_ventas v WHERE ${fv}) AS v_min,
        (SELECT MAX(v.fecha) FROM gestion_ventas v WHERE ${fv}) AS v_max
    ) t
  `);
  return resolveAnioRange(row?.minYear ?? null, row?.maxYear ?? null, new Date().getFullYear());
}

module.exports = {
  ErrorDatos,
  obtenerProyeccion,
  obtenerEquilibrio,
  obtenerEquilibrioVariables,
  guardarEquilibrioVariables,
  obtenerFlujoCaja,
  guardarFlujoCaja,
  obtenerDiferenciaCaja,
  obtenerCanasta,
  anotarAumento,
  borrarAumento,
  obtenerActualizado,
  obtenerRangoAnios,
};
