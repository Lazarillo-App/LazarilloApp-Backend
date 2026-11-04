// Detalle y edición del Panel, portado de lazarillo_gestion/app/api/dashboard/{detalle,
// detalle-ventas,compras/[rowId],ventas/[rowId],compra-lineas/[compraId]}/route.ts,
// lib/dashboard/detalle-conditions.ts y el estado de pago de lib/cta-cte/query.ts.
//
// Tenancy: todo acotado al negocio activo; conceptos, rubros y proveedores son de la
// organización. Donde gestion usaba local/PDV: negocio + sucursal. En las respuestas se
// conservan los nombres de gestion (local = negocio, puntoDeVenta = sucursal).
//
// Pendiente del bloque de apertura: en gestion, editar una compra reevalúa sus reglas de apertura
// (reevaluarCompra). Acá el motor todavía no está, así que una compra ya repartida no se deja
// cambiar en importe, fecha ni concepto (409): quedaría repartida con los números viejos.
'use strict';

const { z } = require('zod');
const { sql, db } = require('../db');
const { buildDateRange, filtroSucursalSql, importeCondition, observacionCondition, rubroVisibleSql, sinRubroVisibleSql } = require('./query-builders');
const { fuenteCompras } = require('./fuente-compras');
const { recortarConHasMore } = require('./recortar-has-more');
const { reshapeDetalle } = require('./reshape-detalle');
const { monthsParam, parseObservacionQuery, parseImporteQuery } = require('./params');
const { DETALLE_COMPRAS_LIMITE, DETALLE_VENTAS_LIMITE, SIN_TIPO_CODE, SIN_COBRO_CODE } = require('./constants');
const { claveComprobante, estadoPago } = require('../cta-cte/estado');
const { combinarPagos } = require('../pagos-proveedor/imputar');
const { impagasDesde } = require('../impagas/query');
const { ErrorDatos } = require('./resultados-api');

const ACENTOS = "áàäâãéèëêíìïîóòöôõúùüûñç";
const SIN_ACENTOS = "aaaaaeeeeiiiiooooouuuunc";
const normalizarTexto = (s) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

const entero = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : undefined; };
const mesValido = (v) => { const n = entero(v); return n && n <= 12 ? n : undefined; };
const anioValido = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : new Date().getFullYear(); };
const codigoValido = (v) => (typeof v === "string" && v.length > 0 && v.length <= 50 ? v : undefined);

// Clave de "dónde está el comprobante" (en gestion: el pdvId de la compra). La sucursal NULL es
// la principal, por eso va como texto: claveComprobante solo descarta null.
const lugarCompra = (businessId, branchId) => `${businessId}:${branchId ?? "p"}`;

// SELECT + JOINs compartidos entre la lista y el lookup por distribucionId.
// `fuente`: compras según el switch Económica / Financiera. fecha/importe son los de la COMPRA (los
// que corrige la edición); fechaVista/importeVista, los que cuentan en la vista elegida.
const detalleSelectJoin = (fuente, organizationId) => sql`
  SELECT
    c."rowId",
    c."distribucionId",
    (c."distribucionId" IS NOT NULL) AS "esDistribuido",
    COALESCE(cb."importeManual", cb.importe) AS "importeBase",
    cb.fecha,
    cb."fechaManual",
    CASE WHEN c."distribucionId" IS NULL THEN cb.importe ELSE da."importeCalculado" END AS importe,
    CASE WHEN c."distribucionId" IS NULL THEN cb."importeManual" END AS "importeManual",
    COALESCE(c."fechaManual", c.fecha)     AS "fechaVista",
    COALESCE(c."importeManual", c.importe) AS "importeVista",
    c."pagoRef",
    COALESCE(cb."fechaManual", cb.periodo, cb.fecha) AS "fechaGasto",
    COALESCE(CASE WHEN c."pagoRef" IS NOT NULL THEN c.fecha END, cb."fechaPago") AS "fechaPago",
    cb."cajaPago",
    c."conceptoCodigoManual",
    c.concepto,
    c.detalle,
    c.observac,
    c."observacManual",
    -- Sin observación: los 3 insumos de más importe del renglón. Se arma al vuelo y no se graba.
    CASE WHEN NULLIF(TRIM(COALESCE(c."observacManual", c.observac)), '') IS NULL THEN (
      SELECT string_agg(t.n, ' · ' ORDER BY t.imp DESC) FROM (
        SELECT TRIM(d.nombre) AS n, SUM(ABS(COALESCE(d."totalIns", d.neto * d.cantidad, 0))) AS imp
        FROM gestion_detalle_compras d
        WHERE d.business_id = cb.business_id AND d."compraId" = cb."rowId"
          AND COALESCE(TRIM(d.medida), '') <> '' AND COALESCE(TRIM(d.nombre), '') <> ''
        GROUP BY 1 ORDER BY 2 DESC LIMIT 3) t)
    END AS "obsInsumos",
    c.proveedor AS "proveedorTexto",
    p.id                AS "proveedorId",
    p.nombre            AS "proveedorNombre",
    p.razon             AS "proveedorRazon",
    neg.name            AS "localNombre",
    COALESCE(br.name, 'Principal') AS "pdvNombre",
    c.business_id_origen AS "localIdOrigen",
    c.branch_id_origen   AS "puntoDeVentaIdOrigen",
    cc.codigo           AS "conceptoCajaCodigo",
    cc.nombre           AS "conceptoCajaNombre",
    rc.nombre           AS "conceptoCajaRubroNombre",
    ccm.codigo          AS "conceptoCajaManualCodigo",
    ccm.nombre          AS "conceptoCajaManualNombre",
    rcm.nombre          AS "conceptoCajaManualRubroNombre",
    cb.comprobante      AS "comprobante",
    cb.codigo           AS "codigoProveedor",
    cb.business_id      AS "negocioCompra",
    cb.branch_id        AS "sucursalCompra"
  FROM ${fuente} c
  -- Compra base: en una fila de reparto la vista trae solo la parte del destino.
  JOIN gestion_compras cb             ON cb.business_id = c.business_id_origen AND cb."rowId" = c."rowId"
  LEFT JOIN gestion_distribuciones_apertura da ON da.id = c."distribucionId"
  LEFT JOIN gestion_proveedores p     ON c."proveedorId" = p.id
  LEFT JOIN app_businesses neg        ON c.business_id = neg.id
  LEFT JOIN app_branches br           ON c.branch_id = br.id
  -- Concepto original y manual POR SEPARADO.
  LEFT JOIN gestion_conceptos_caja cc        ON cc.organization_id = ${organizationId} AND c."conceptoCodigo" = cc.codigo
  LEFT JOIN gestion_rubros_concepto_caja rc  ON rc.organization_id = ${organizationId} AND cc."codRga" = rc.codigo
  LEFT JOIN gestion_conceptos_caja ccm       ON ccm.organization_id = ${organizationId} AND c."conceptoCodigoManual" = ccm.codigo
  LEFT JOIN gestion_rubros_concepto_caja rcm ON rcm.organization_id = ${organizationId} AND ccm."codRga" = rcm.codigo
`;

const aFila = (r) => ({
  ...reshapeDetalle({ ...r, pdvCompraId: lugarCompra(r.negocioCompra, r.sucursalCompra) }),
  negocioCompra: r.negocioCompra,
  sucursalCompra: r.sucursalCompra,
});

// WHERE de la lista: tiene que traer exactamente las compras que suma la celda clickeada del pivot.
// Alias: c (fuente), p (proveedores), rc_ef / rv (rubro del concepto efectivo y su visibilidad).
function buildDetalleConditions({
  businessId, sucursal, year, mes, meses, proveedorId, proveedorTexto, codigo, sinProveedor,
  rubroCodigo, conceptoCodigo, observacionQuery, importeQuery, historico = false,
}) {
  const { fechaStart, fechaEnd } = buildDateRange(year, mes);
  const conditions = [
    filtroSucursalSql("c", businessId, sucursal),
    ...(historico
      ? []
      : [sql`COALESCE(c."fechaManual", c.fecha) >= ${fechaStart} AND COALESCE(c."fechaManual", c.fecha) < ${fechaEnd}`]),
    sql`(c.fecha IS NOT NULL OR c."fechaManual" IS NOT NULL)`,
    sql`COALESCE(c."importeManual", c.importe) IS NOT NULL AND COALESCE(c."importeManual", c.importe) != 0`,
  ];
  if (!historico && !mes && meses?.length) {
    conditions.push(sql`EXTRACT(MONTH FROM COALESCE(c."fechaManual", c.fecha))::int IN (${sql.join(meses.map((m) => sql`${m}`))})`);
  }
  if (proveedorId !== undefined) conditions.push(sql`p.id = ${proveedorId}`);
  else if (proveedorTexto !== undefined) {
    // codigo es un AND adicional: dos personas con el mismo texto solo se separan por su código real.
    conditions.push(
      codigo !== undefined
        ? sql`c."proveedorId" IS NULL AND c.proveedor = ${proveedorTexto} AND c.codigo = ${codigo}`
        : sql`c."proveedorId" IS NULL AND c.proveedor = ${proveedorTexto}`
    );
  } else if (sinProveedor) conditions.push(sql`c."proveedorId" IS NULL AND c.proveedor IS NULL`);

  // Concepto EFECTIVO (manual si existe), mismo criterio que el pivot: una compra reclasificada
  // tiene que aparecer en su rubro nuevo.
  if (rubroCodigo && !conceptoCodigo) {
    conditions.push(sql`COALESCE(rc_ef.codigo, '__sin_rubro') = ${rubroCodigo}`);
  } else if (conceptoCodigo) {
    conditions.push(sql`COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = ${conceptoCodigo}`);
  } else {
    conditions.push(sql`((rc_ef.codigo IS NOT NULL AND ${rubroVisibleSql("visibleEnDashboard")}) OR (rc_ef.codigo IS NULL AND ${sinRubroVisibleSql("visibleEnDashboard", businessId)}))`);
  }
  if (observacionQuery) conditions.push(observacionCondition("c", observacionQuery));
  if (importeQuery) {
    const cond = importeCondition("c", importeQuery);
    if (cond) conditions.push(cond);
  }
  return conditions;
}

// Estado de pago de cada comprobante (compras cruzadas con los pagos del informe 80 y los
// cargados en Lazarillo). organización = dueña del maestro de proveedores.
async function estadosDePago(organizationId, filas) {
  const unicas = new Map();
  for (const f of filas) {
    const k = claveComprobante(f.pdvCompraId, f.comprobante ?? null, f.codigoProveedor ?? null);
    if (k && !unicas.has(k)) unicas.set(k, f);
  }
  const res = new Map();
  if (!unicas.size) return res;
  const l = [...unicas.values()];
  const rows = await db.many(sql`
    WITH k AS (
      SELECT * FROM UNNEST(${l.map((f) => f.negocioCompra)}::bigint[], ${l.map((f) => f.sucursalCompra)}::bigint[],
                           ${l.map((f) => f.comprobante)}::text[], ${l.map((f) => f.codigoProveedor)}::text[]) AS k(biz, suc, cpb, cod)
    )
    SELECT k.biz, k.suc, k.cpb, k.cod,
      (SELECT SUM(COALESCE(c."importeManual", c.importe))::float8 FROM gestion_compras c
        WHERE c.business_id = k.biz AND c.branch_id IS NOT DISTINCT FROM k.suc AND c.comprobante = k.cpb AND c.codigo = k.cod) AS total14,
      (SELECT MAX(p.total)::float8 FROM gestion_pagos p
        WHERE p.business_id = k.biz AND p.branch_id IS NOT DISTINCT FROM k.suc AND p.comprobante = k.cpb AND p."codPro" = k.cod) AS total80,
      (SELECT JSON_AGG(JSON_BUILD_OBJECT('fecha', TO_CHAR(p."fechaPago", 'YYYY-MM-DD'), 'importe', p.importe::float8)) FROM gestion_pagos p
        WHERE p.business_id = k.biz AND p.branch_id IS NOT DISTINCT FROM k.suc AND p.comprobante = k.cpb AND p."codPro" = k.cod AND p.importe IS NOT NULL) AS p80,
      (SELECT JSON_AGG(JSON_BUILD_OBJECT('fecha', TO_CHAR(pp.fecha, 'YYYY-MM-DD'), 'importe', a.importe::float8))
        FROM gestion_aplicaciones_pago_proveedor a JOIN gestion_pagos_proveedor pp ON pp.id = a."pagoId" AND pp."anuladoEn" IS NULL
        WHERE a.business_id = k.biz AND a.branch_id IS NOT DISTINCT FROM k.suc AND a.comprobante = k.cpb AND a."codPro" = k.cod) AS plz,
      (SELECT BOOL_OR(pr."pagoAutomatico") FROM gestion_proveedores pr WHERE pr.organization_id = ${organizationId} AND pr.codigo = k.cod) AS auto
    FROM k
  `);
  const desde = impagasDesde(null, process.env.IMPAGAS_DESDE);
  for (const r of rows) {
    const k = claveComprobante(lugarCompra(r.biz, r.suc), r.cpb, r.cod);
    const total = Number(r.total80 ?? r.total14 ?? 0);
    const p80 = r.p80 ?? [];
    const plz = r.plz ?? [];
    // 80 + Lazarillo (el mismo pago en los dos lados cuenta una vez).
    const comb = combinarPagos(p80, plz, total);
    const vigentes = [...p80, ...plz.filter((_, i) => !comb.conciliados.includes(i))];
    const ultimo = vigentes.reduce((m, x) => (x.fecha && (!m || x.fecha > m) ? x.fecha : m), null);
    const iso = unicas.get(k);
    const fecha = (iso?.fechaManual ?? iso?.fecha)?.toISOString?.().slice(0, 10) ?? null;
    const e = estadoPago({ comprobante: r.cpb, fecha, total, pagado: comb.pagado, pagoAutomatico: !!r.auto }, desde);
    if (e) res.set(k, { estado: e, total, pagado: comb.pagado, ultimoPago: ultimo, pagos: vigentes.length });
  }
  return res;
}

// Si falla el semáforo, la lista sale igual sin estado.
async function conEstado(organizationId, filas) {
  let estados = new Map();
  try {
    estados = await estadosDePago(organizationId, filas);
  } catch (err) {
    console.error("[gestion/detalle] estado de pago", err);
  }
  return filas.map(({ negocioCompra: _n, sucursalCompra: _s, ...f }) => {
    const k = claveComprobante(f.pdvCompraId, f.comprobante ?? null, f.codigoProveedor ?? null);
    const estado = (k && estados.get(k)) || null;
    // Factura en Económica: fecha del último pago del 80 (en Financiera cada fila ya es un pago).
    const fechaPago = f.fechaPago ?? (!f.pagoRef && estado?.ultimoPago ? estado.ultimoPago : null);
    return { ...f, fechaPago, estadoPago: estado };
  });
}

// GET detalle de compras: una celda del pivot, un registro puntual (rowId), o con ?q el buscador
// del modal. sp = URLSearchParams.
async function obtenerDetalleCompras({ organizationId, businessId, sucursal, sp }) {
  const year = anioValido(sp.get("year") ?? undefined);
  const rowId = sp.get("rowId") ?? undefined;
  const distribucionId = entero(sp.get("distribucionId"));

  if (rowId) {
    // (a) Con distribucionId: esa porción puntual, del negocio activo (es su destino).
    if (distribucionId !== undefined) {
      const rows = await db.many(sql`
        ${detalleSelectJoin(fuenteCompras(undefined), organizationId)}
        WHERE c.business_id = ${businessId} AND c."rowId" = ${rowId} AND c."distribucionId" = ${distribucionId}
        LIMIT 1
      `);
      return { data: await conEstado(organizationId, rows.map(aFila)), hasMore: false };
    }
    // (b) La compra completa, del negocio activo.
    const rows = await db.many(sql`
      SELECT
        c."rowId", NULL::int AS "distribucionId", c."esDistribuido",
        COALESCE(c."importeManual", c.importe) AS "importeBase",
        c.fecha, c."fechaManual", c.importe, c."importeManual",
        COALESCE(c."fechaManual", c.fecha) AS "fechaVista",
        COALESCE(c."importeManual", c.importe) AS "importeVista",
        NULL::text AS "pagoRef",
        COALESCE(c."fechaManual", c.fecha) AS "fechaGasto",
        c."fechaPago", c."cajaPago", c."conceptoCodigoManual", c.concepto, c.detalle, c.observac, c."observacManual",
        c.proveedor AS "proveedorTexto",
        p.id AS "proveedorId", p.nombre AS "proveedorNombre", p.razon AS "proveedorRazon",
        neg.name AS "localNombre", COALESCE(br.name, 'Principal') AS "pdvNombre",
        c.business_id AS "localIdOrigen", c.branch_id AS "puntoDeVentaIdOrigen",
        cc.codigo AS "conceptoCajaCodigo", cc.nombre AS "conceptoCajaNombre", rc.nombre AS "conceptoCajaRubroNombre",
        ccm.codigo AS "conceptoCajaManualCodigo", ccm.nombre AS "conceptoCajaManualNombre", rcm.nombre AS "conceptoCajaManualRubroNombre",
        c.comprobante, c.codigo AS "codigoProveedor", c.business_id AS "negocioCompra", c.branch_id AS "sucursalCompra"
      FROM gestion_compras c
      LEFT JOIN gestion_proveedores p ON c."proveedorId" = p.id
      LEFT JOIN app_businesses neg    ON c.business_id = neg.id
      LEFT JOIN app_branches br       ON c.branch_id = br.id
      LEFT JOIN gestion_conceptos_caja cc        ON cc.organization_id = ${organizationId} AND c."conceptoCodigo" = cc.codigo
      LEFT JOIN gestion_rubros_concepto_caja rc  ON rc.organization_id = ${organizationId} AND cc."codRga" = rc.codigo
      LEFT JOIN gestion_conceptos_caja ccm       ON ccm.organization_id = ${organizationId} AND c."conceptoCodigoManual" = ccm.codigo
      LEFT JOIN gestion_rubros_concepto_caja rcm ON rcm.organization_id = ${organizationId} AND ccm."codRga" = rcm.codigo
      WHERE c.business_id = ${businessId} AND c."rowId" = ${rowId}
    `);
    return { data: await conEstado(organizationId, rows.map(aFila)), hasMore: false };
  }

  const proveedorTextoRaw = sp.get("proveedorTexto");
  const condiciones = buildDetalleConditions({
    businessId, sucursal, year,
    mes: mesValido(sp.get("mes")),
    meses: monthsParam.safeParse(sp.get("months")).data,
    proveedorId: entero(sp.get("proveedorId")),
    proveedorTexto: proveedorTextoRaw && proveedorTextoRaw.length <= 256 ? proveedorTextoRaw : undefined,
    codigo: codigoValido(sp.get("codigo")),
    sinProveedor: sp.get("sinProveedor") === "1",
    rubroCodigo: codigoValido(sp.get("rubroCodigo")),
    conceptoCodigo: codigoValido(sp.get("conceptoCodigo")),
    observacionQuery: parseObservacionQuery(sp.get("observacionQuery")),
    importeQuery: parseImporteQuery(sp.get("importeQuery")),
    historico: sp.get("historico") === "1",
  });

  // Vista Insumos: compras que traen ese insumo en el 25 / compras sin insumos (van por concepto).
  const lineas = (filtro) => sql`EXISTS (SELECT 1 FROM gestion_detalle_compras d
    WHERE d.business_id = cb.business_id AND d.branch_id IS NOT DISTINCT FROM cb.branch_id
      AND d.comprobante = cb.comprobante AND d."codPro" = cb.codigo AND d."codCga" = cb."codCga"
      AND NULLIF(TRIM(d.medida), '') IS NOT NULL AND ${filtro})`;
  const insumoCodigo = codigoValido(sp.get("insumoCodigo"));
  if (insumoCodigo) condiciones.push(lineas(sql`d.codigo = ${insumoCodigo}`));
  if (sp.get("sinInsumos") === "1") condiciones.push(sql`NOT ${lineas(sql`TRUE`)}`);

  // Buscador del modal (Año / Histórico): algún campo contiene el texto, sin mayúsculas ni acentos.
  const q = normalizarTexto((sp.get("q") ?? "").trim().slice(0, 80));
  if (q) {
    const campos = [
      sql`c.proveedor`, sql`p.nombre`, sql`p.razon`, sql`c."observacManual"`, sql`c.observac`, sql`c.detalle`,
      sql`c.concepto`, sql`cc_ef.nombre`, sql`rc_ef.nombre`, sql`neg.name`,
    ];
    const patron = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    condiciones.push(sql`(${sql.join(
      campos.map((f) => sql`translate(lower(COALESCE(${f}, '')), ${ACENTOS}, ${SIN_ACENTOS}) LIKE ${patron}`),
      " OR "
    )})`);
  }

  const modo = sp.get("modo") === "financiera" ? "financiera" : undefined;
  const rows = await db.many(sql`
    ${detalleSelectJoin(fuenteCompras(modo), organizationId)}
    -- Concepto/rubro EFECTIVO: solo para filtrar (mismo criterio que el pivot).
    LEFT JOIN gestion_conceptos_caja cc_ef       ON cc_ef.organization_id = ${organizationId}
                                                 AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = cc_ef.codigo
    LEFT JOIN gestion_rubros_concepto_caja rc_ef ON rc_ef.organization_id = ${organizationId} AND cc_ef."codRga" = rc_ef.codigo
    LEFT JOIN gestion_rubros_visibilidad rv      ON rv.business_id = ${businessId} AND rv.codigo = rc_ef.codigo
    WHERE ${sql.join(condiciones, " AND ")}
    -- Si hay que cortar quedan los MÁS NUEVOS; después se devuelven en orden ascendente.
    ORDER BY COALESCE(c."fechaManual", c.fecha) DESC, c."rowId" DESC, c."distribucionId" DESC NULLS LAST, c."pagoRef" DESC NULLS LAST
    LIMIT ${DETALLE_COMPRAS_LIMITE + 1}
  `);
  const { data, hasMore } = recortarConHasMore(rows, DETALLE_COMPRAS_LIMITE);
  return { data: await conEstado(organizationId, data.reverse().map(aFila)), hasMore };
}

// GET detalle de ventas (una celda del pivot de ventas).
async function obtenerDetalleVentas({ businessId, sucursal, sp }) {
  const year = anioValido(sp.get("year") ?? undefined);
  const { fechaStart, fechaEnd } = buildDateRange(year, mesValido(sp.get("mes")));
  const tipo = codigoValido(sp.get("tipoCodigo"));
  const cobro = codigoValido(sp.get("cobroCodigo"));
  const condiciones = [
    filtroSucursalSql("v", businessId, sucursal),
    sql`v.fecha >= ${fechaStart} AND v.fecha < ${fechaEnd}`,
    sql`COALESCE(v."importeManual", v.importe) IS NOT NULL AND COALESCE(v."importeManual", v.importe) != 0`,
  ];
  if (tipo) condiciones.push(tipo === SIN_TIPO_CODE ? sql`v.tipo IS NULL` : sql`v.tipo = ${tipo}`);
  if (cobro) condiciones.push(cobro === SIN_COBRO_CODE ? sql`v."codCobro" IS NULL` : sql`v."codCobro" = ${cobro}`);
  const rows = await db.many(sql`
    SELECT v."rowId", v.fecha, v.importe, v."importeManual", v.tipo, v.cobro, v.turno, v.comprobant, v.hora, v.mesa, v.mozo,
           v.total, v.descuento, v.cupon, neg.name AS negocio, COALESCE(br.name, 'Principal') AS sucursal
    FROM gestion_ventas v
    LEFT JOIN app_businesses neg ON v.business_id = neg.id
    LEFT JOIN app_branches br    ON v.branch_id = br.id
    WHERE ${sql.join(condiciones, " AND ")}
    ORDER BY v.fecha, v."rowId"
    LIMIT ${DETALLE_VENTAS_LIMITE + 1}
  `);
  const { data, hasMore } = recortarConHasMore(rows, DETALLE_VENTAS_LIMITE);
  return {
    data: data.map(({ negocio, sucursal: suc, ...v }) => ({ ...v, local: { nombre: negocio }, puntoDeVenta: { nombre: suc } })),
    hasMore,
  };
}

// GET líneas de una factura. Por comprobante + proveedor (no por compraId): una misma factura
// viene dividida en varias filas por concepto y se muestra completa bajo cualquiera de ellas.
async function obtenerCompraLineas({ businessId, compraId }) {
  const compra = await db.one(sql`
    SELECT comprobante, branch_id, codigo FROM gestion_compras WHERE business_id = ${businessId} AND "rowId" = ${compraId}`);
  if (!compra) return { data: [] };
  const donde = compra.comprobante
    ? sql`d.comprobante = ${compra.comprobante} AND d.branch_id IS NOT DISTINCT FROM ${compra.branch_id}::bigint
          ${compra.codigo ? sql`AND d."codPro" = ${compra.codigo}` : sql``}`
    : sql`d."compraId" = ${compraId}`;
  const data = await db.many(sql`
    SELECT d."rowId", d.codigo, d.nombre, d.cantidad, d.medida, d.neto, d."totalIns", d."ivaTot", d."impNtTot", d.observac
    FROM gestion_detalle_compras d
    WHERE d.business_id = ${businessId} AND ${donde}
    ORDER BY d."rowId"`);
  return { data };
}

const patchCompra = z.object({
  importeManual: z.number().nullable().optional(),
  fechaManual: z.string().datetime({ offset: true }).nullable().optional(),
  conceptoCodigoManual: z.string().max(50).nullable().optional(),
  observacManual: z.string().max(500).nullable().optional().transform((v) => (v === "" ? null : v)),
});

// PATCH de una compra del negocio activo: los campos manuales (la reimportación no los pisa).
async function editarCompra({ organizationId, businessId, rowId, body }) {
  const parsed = patchCompra.safeParse(body);
  if (!parsed.success) { const e = new ErrorDatos("Datos inválidos"); e.status = 422; throw e; }
  const { importeManual, fechaManual, conceptoCodigoManual, observacManual } = parsed.data;

  return db.transaction(async (tx) => {
    const compra = await tx.one(sql`
      SELECT "rowId", "conceptoCodigoManual", "esDistribuido" FROM gestion_compras
      WHERE business_id = ${businessId} AND "rowId" = ${rowId} FOR UPDATE`);
    if (!compra) { const e = new ErrorDatos("Registro no encontrado"); e.status = 404; throw e; }

    const afectaReparto = importeManual !== undefined || fechaManual !== undefined || conceptoCodigoManual !== undefined;
    if (afectaReparto && compra.esDistribuido) {
      const e = new ErrorDatos("Esta compra está repartida entre negocios: por ahora solo se puede cambiar su observación.");
      e.status = 409;
      throw e;
    }
    if (conceptoCodigoManual) {
      const existe = await tx.one(sql`SELECT 1 AS ok FROM gestion_conceptos_caja WHERE organization_id = ${organizationId} AND codigo = ${conceptoCodigoManual}`);
      if (!existe) { const e = new ErrorDatos("Concepto no encontrado"); e.status = 404; throw e; }
    }

    const sets = [];
    if (importeManual !== undefined) sets.push(sql`"importeManual" = ${importeManual}::numeric`);
    if (fechaManual !== undefined) sets.push(sql`"fechaManual" = ${fechaManual}::timestamptz AT TIME ZONE 'UTC'`);
    if (conceptoCodigoManual !== undefined) sets.push(sql`"conceptoCodigoManual" = ${conceptoCodigoManual}`);
    if (observacManual !== undefined) sets.push(sql`"observacManual" = ${observacManual}`);
    // Si una persona cambia el concepto, deja de ser el "concepto fijo del empleado".
    if (conceptoCodigoManual !== undefined && conceptoCodigoManual !== compra.conceptoCodigoManual) sets.push(sql`"conceptoPorRegla" = NULL`);
    if (!sets.length) return { rowId, reevaluada: false, distribuidaAhora: false };

    const updated = await tx.one(sql`
      UPDATE gestion_compras SET ${sql.join(sets, ", ")}
      WHERE business_id = ${businessId} AND "rowId" = ${rowId}
      RETURNING "rowId", "importeManual", "fechaManual", "conceptoCodigoManual", "observacManual"`);
    return { ...updated, reevaluada: false, distribuidaAhora: false };
  });
}

// PATCH de una venta del negocio activo: solo el importe manual.
async function editarVenta({ businessId, rowId, body }) {
  const importeManual = body?.importeManual;
  const valido = importeManual === undefined || importeManual === null || (typeof importeManual === "number" && Number.isFinite(importeManual));
  if (!valido) { const e = new ErrorDatos("Datos inválidos"); e.status = 422; throw e; }
  if (importeManual === undefined) return { rowId };
  const updated = await db.one(sql`
    UPDATE gestion_ventas SET "importeManual" = ${importeManual}::numeric
    WHERE business_id = ${businessId} AND "rowId" = ${rowId}
    RETURNING "rowId", "importeManual"`);
  if (!updated) { const e = new ErrorDatos("Registro no encontrado"); e.status = 404; throw e; }
  return updated;
}

module.exports = { buildDetalleConditions, obtenerDetalleCompras, obtenerDetalleVentas, obtenerCompraLineas, editarCompra, editarVenta };
