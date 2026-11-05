// services/gestion/pagos-api.js
// Sin carga, Impagas, pagos a proveedores, órdenes de pago entre lugares y cuenta corriente.
// Port de lazarillo_gestion (app/api/{sin-carga,impagas,pagos-proveedor,cta-cte}, lib/sin-carga/query,
// lib/impagas/query, lib/cta-cte/query, lib/pagos-proveedor/{registrar,server}).
//
// Un "PDV" de gestion es acá un LUGAR: la principal (-business_id) o una sucursal (branch_id).
//
// La cuenta corriente y los pagos se ven por NEGOCIO, no por organización: en gestion juntaba todos
// los PDV de la instancia, pero acá los datos de un negocio no se muestran en otro. Los maestros
// (proveedores, conceptos) sí son de la organización. Las órdenes de pago entre lugares pueden
// cruzar negocios de la misma organización: nacen de una regla de apertura.
'use strict';

const { z } = require('zod');
const { sql, db } = require('./db');
const { ErrorDatos } = require('./dashboard/resultados-api');
const { rubroVisibleSql, sinRubroVisibleSql } = require('./dashboard/query-builders');
const { GV_CODIGO } = require('./gastos-varios/periodo');
const { obtenerLugares, idLugar } = require('./carga-api');
const { impagasDesde } = require('./impagas/query');
const { normalizarReferencia, imputarElegidos, imputarFifo, numeroOP, redondear } = require('./impagas/aperturas');
const { fmtPesos, fmtFecha, fmtComprobante } = require('./impagas/clasificar');
const { estadoPago } = require('./cta-cte/estado');
const { claveFactura, combinarPagos, imputarFacturas, numeroPago, recortarAplicaciones } = require('./pagos-proveedor/imputar');
const { esConceptoFeriado, feriadosDelMes } = require('./feriados');
const {
  esperadoEnMesCerrado, estaAtrasado, mesesObjetivo, resumenCompra, venceEl, RECURRENTE_MIN, RECURRENTE_VENTANA,
} = require('./sin-carga/estado');

const rechazo = (mensaje, status = 400, extra) => {
  const e = new ErrorDatos(mensaje);
  e.status = status;
  e.extra = extra;
  return e;
};
const exigirSucursal = (sucursal) => { if (sucursal === undefined) throw rechazo('Elegí una sucursal'); };
const fechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hoyArgentina = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);

// El lugar de una fila, con la misma numeración que idLugar().
const lugarSql = (alias, negocio = 'business_id', sucursal = 'branch_id') =>
  sql.raw(`(CASE WHEN ${alias}.${sucursal} IS NOT NULL THEN ${alias}.${sucursal} ELSE -${alias}.${negocio} END)::int`);
const enLugar = (alias, businessId, sucursal) =>
  sql`${sql.raw(alias)}.business_id = ${businessId} AND ${sql.raw(alias)}.branch_id IS NOT DISTINCT FROM ${sucursal}::bigint`;

// Lugares del negocio por id; el de una factura o de quien paga tiene que estar acá.
async function mapaLugares(cliente, businessId) {
  return new Map((await obtenerLugares(cliente, businessId)).map((l) => [l.id, l]));
}

// Un lugar de cualquier negocio de la organización (origen de una orden de pago).
async function lugarDeOrganizacion(cliente, organizationId, id) {
  if (!Number.isInteger(id) || id === 0) return null;
  if (id < 0) {
    const b = await cliente.one(sql`SELECT id, name FROM app_businesses WHERE id = ${-id} AND organization_id = ${organizationId}`);
    return b ? { id, businessId: Number(b.id), branchId: null, nombre: b.name } : null;
  }
  const s = await cliente.one(sql`
    SELECT br.id, br.name, br.business_id FROM app_branches br JOIN app_businesses b ON b.id = br.business_id
    WHERE br.id = ${id} AND b.organization_id = ${organizationId}`);
  return s ? { id, businessId: Number(s.business_id), branchId: Number(s.id), nombre: s.name } : null;
}

// ── Medios de pago e ID de transferencia ─────────────────────────────
async function medioValido(cliente, businessId, nombre, actual) {
  if (actual != null && nombre === actual) return true;
  const m = await cliente.one(sql`SELECT activo FROM gestion_medios_pago WHERE business_id = ${businessId} AND nombre = ${nombre}`);
  return !!m?.activo;
}

// El ID de la transferencia no se repite (ni en pagos a proveedores ni en órdenes de pago).
async function referenciaRepetida(cliente, organizationId, referencia, exceptoPago) {
  const prov = await cliente.one(sql`
    SELECT id FROM gestion_pagos_proveedor
    WHERE organization_id = ${organizationId} AND referencia = ${referencia} AND "anuladoEn" IS NULL
      AND (${exceptoPago ?? null}::int IS NULL OR id <> ${exceptoPago ?? null}::int) LIMIT 1`);
  if (prov) return true;
  return !!(await cliente.one(sql`SELECT id FROM gestion_pagos_internos WHERE organization_id = ${organizationId} AND referencia = ${referencia} LIMIT 1`));
}

function referenciaDe(crudo) {
  if (!crudo?.trim()) return null;
  const r = normalizarReferencia(crudo);
  if (!r) throw rechazo('El ID tiene que ser de letras y números.');
  return r;
}

// ── Sin carga ─────────────────────────────────────────────────────────
const ANUAL = 12;

function sinCargaSql({ organizationId, businessId, sucursal, meses }) {
  const desde = meses[meses.length - 1];
  const hasta = meses[0];
  const fechaEco = sql`COALESCE(c."fechaManual", c.periodo, c.fecha)`;
  const col = 'visibleEnDashboard';
  return sql`
    WITH b AS (
      SELECT date_trunc('month', ${fechaEco})::date AS mes,
             EXTRACT(day FROM COALESCE(c."fechaManual", c.fecha))::int AS dia,
             (c.periodo IS NOT NULL) AS vencido,
             CASE WHEN c."proveedorId" IS NOT NULL AND pr.codigo <> ${GV_CODIGO} THEN 'p:' || c."proveedorId"
                  ELSE 'c:' || COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") END AS clave,
             CASE WHEN pr.codigo <> ${GV_CODIGO} THEN c."proveedorId" END AS proveedor_id,
             CASE WHEN pr.codigo <> ${GV_CODIGO} THEN COALESCE(pr.nombre, pr.razon) END AS proveedor,
             COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") AS concepto_codigo,
             TRIM(COALESCE(cc.nombre, c.concepto)) AS concepto,
             TRIM(rc.nombre) AS rubro,
             COALESCE(c."importeManual", c.importe) AS imp,
             c."rowId" AS row_id, ${lugarSql('c', 'business_id_origen', 'branch_id_origen')} AS pdv_origen,
             COALESCE(o."importeManual", o.importe) AS imp_total
      FROM gestion_v_compras_distribuidas c
      JOIN gestion_compras o ON o.business_id = c.business_id_origen AND o."rowId" = c."rowId"
      LEFT JOIN gestion_proveedores pr ON pr.id = c."proveedorId"
      LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId} AND cc.codigo = COALESCE(c."conceptoCodigoManual", c."conceptoCodigo")
      LEFT JOIN gestion_rubros_concepto_caja rc ON rc.organization_id = ${organizationId} AND rc.codigo = cc."codRga"
      LEFT JOIN gestion_rubros_visibilidad rv ON rv.business_id = ${businessId} AND rv.codigo = rc.codigo
      WHERE ${enLugar('c', businessId, sucursal)}
        AND ${fechaEco} >= (${desde}::date - make_interval(months => ${ANUAL}))
        AND ${fechaEco} <  (${hasta}::date + interval '1 month')
        AND ((rc.codigo IS NOT NULL AND ${rubroVisibleSql(col)}) OR (rc.codigo IS NULL AND ${sinRubroVisibleSql(col, businessId)}))
        AND (c."proveedorId" IS NOT NULL OR COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") IS NOT NULL)
    ),
    tot AS (
      SELECT clave, mes, SUM(imp_total) AS imp_total, MODE() WITHIN GROUP (ORDER BY pdv_origen) AS pdv_origen
      FROM (SELECT DISTINCT clave, mes, row_id, imp_total, pdv_origen FROM b) d
      GROUP BY clave, mes
    ),
    pm0 AS (
      SELECT clave, mes, SUM(imp) AS imp, AVG(dia) AS dia, BOOL_OR(vencido) AS vencido,
             MIN(proveedor_id) AS proveedor_id, MIN(proveedor) AS proveedor,
             (array_agg(concepto ORDER BY imp DESC))[1] AS concepto,
             (array_agg(concepto_codigo ORDER BY imp DESC))[1] AS concepto_codigo,
             (array_agg(rubro ORDER BY imp DESC))[1] AS rubro
      FROM b GROUP BY clave, mes
    ),
    pm AS (SELECT pm0.*, tot.imp_total, tot.pdv_origen FROM pm0 JOIN tot USING (clave, mes)),
    obj AS (SELECT unnest(${meses}::date[]) AS m),
    r AS (
      SELECT o.m, x.clave, COUNT(*) AS n,
             (array_agg(x.imp ORDER BY x.mes DESC))[1] AS ultimo,
             (array_agg(x.proveedor ORDER BY x.mes DESC))[1] AS proveedor,
             (array_agg(x.proveedor_id ORDER BY x.mes DESC))[1] AS proveedor_id,
             (array_agg(x.concepto ORDER BY x.mes DESC))[1] AS concepto,
             (array_agg(x.concepto_codigo ORDER BY x.mes DESC))[1] AS concepto_codigo,
             (array_agg(x.rubro ORDER BY x.mes DESC))[1] AS rubro,
             AVG(x.dia) AS dia, BOOL_OR(x.vencido) AS vencido,
             (array_agg(x.imp_total ORDER BY x.mes DESC))[1] AS ultimo_total,
             (array_agg(x.pdv_origen ORDER BY x.mes DESC))[1] AS pdv_origen
      FROM obj o
      JOIN pm x ON x.mes < o.m AND x.mes >= o.m - make_interval(months => ${RECURRENTE_VENTANA})
      GROUP BY o.m, x.clave
      HAVING COUNT(*) >= ${RECURRENTE_MIN}
    ),
    n12 AS (
      SELECT o.m, x.clave, COUNT(*) AS n FROM obj o
      JOIN pm x ON x.mes < o.m AND x.mes >= o.m - make_interval(months => ${ANUAL})
      GROUP BY o.m, x.clave
    ),
    h12 AS (
      SELECT o.m, COUNT(DISTINCT b.mes) AS h FROM obj o
      JOIN b ON b.mes < o.m AND b.mes >= o.m - make_interval(months => ${ANUAL})
      GROUP BY o.m
    )
    SELECT to_char(r.m, 'YYYY-MM') AS mes, r.clave, r.proveedor, r.proveedor_id::int AS proveedor_id,
           r.concepto, r.concepto_codigo, r.rubro, ROUND(r.ultimo, 2)::float8 AS ultimo,
           ROUND(r.dia)::int AS dia, r.vencido,
           r.pdv_origen::int AS pdv_origen, ROUND(r.ultimo_total, 2)::float8 AS ultimo_total,
           COALESCE(n12.n, 0)::int AS meses_con_gasto, COALESCE(h12.h, 0)::int AS meses_con_datos
    FROM r
    LEFT JOIN n12 ON n12.m = r.m AND n12.clave = r.clave
    LEFT JOIN h12 ON h12.m = r.m
    WHERE r.ultimo > 0
      AND NOT EXISTS (SELECT 1 FROM pm WHERE pm.clave = r.clave AND pm.mes = r.m)
      -- "Ya no va": la clave sola; "Este mes no": la clave con "@YYYY-MM".
      AND NOT EXISTS (SELECT 1 FROM gestion_sin_carga_descartes d WHERE ${enLugar('d', businessId, sucursal)}
                        AND d.clave IN (r.clave, r.clave || '@' || to_char(r.m, 'YYYY-MM')))
    ORDER BY r.m DESC, r.ultimo DESC`;
}

// Qué se le compra a cada proveedor en este negocio: insumos y conceptos, para decidir si "este mes va".
function queCompraSql({ organizationId, businessId, ids, desde }) {
  return sql`
    SELECT c."proveedorId" AS pid, 'i' AS tipo, TRIM(d.nombre) AS txt, TRIM(COALESCE(cc.nombre, d."nomCga", c.concepto)) AS obs,
           SUM(ABS(COALESCE(d."totalIns", d.neto * d.cantidad, 0)))::float8 AS imp -- "neto" del 25 es el unitario
    FROM gestion_detalle_compras d
    JOIN gestion_compras c ON c.business_id = d.business_id AND c."rowId" = d."compraId"
    LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId} AND cc.codigo = d."codCga"
    WHERE c.business_id = ${businessId} AND c."proveedorId" = ANY(${ids}::int[]) AND COALESCE(c."fechaManual", c.fecha) >= ${desde}::date
      AND COALESCE(TRIM(d.medida), '') <> '' AND COALESCE(TRIM(d.nombre), '') <> ''
    GROUP BY 1, 3, 4
    UNION ALL
    SELECT c."proveedorId", 'c', TRIM(COALESCE(cc.nombre, c.concepto)),
           (array_agg(NULLIF(TRIM(COALESCE(c."observacManual", c.observac)), '') ORDER BY c.fecha DESC)
              FILTER (WHERE NULLIF(TRIM(COALESCE(c."observacManual", c.observac)), '') IS NOT NULL))[1],
           SUM(ABS(COALESCE(c."importeManual", c.importe)))::float8
    FROM gestion_compras c
    LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId} AND cc.codigo = COALESCE(c."conceptoCodigoManual", c."conceptoCodigo")
    WHERE c.business_id = ${businessId} AND c."proveedorId" = ANY(${ids}::int[]) AND c.fecha >= ${desde}::date
      AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo", '') NOT IN ('133', '899', '137') -- percepciones
    GROUP BY 1, 3`;
}

async function obtenerSinCarga({ organizationId, businessId, sucursal }) {
  exigirSucursal(sucursal);
  const hoy = hoyArgentina();
  const objetivo = mesesObjetivo(hoy);
  const [filas, descartes] = await Promise.all([
    db.many(sinCargaSql({ organizationId, businessId, sucursal, meses: objetivo })),
    db.many(sql`
      SELECT id, clave, nombre, "creadoEn" FROM gestion_sin_carga_descartes d
      WHERE ${enLugar('d', businessId, sucursal)} AND clave ~ '^[pc]:' ORDER BY "creadoEn" DESC`),
  ]);
  const mesActual = objetivo[0].slice(0, 7);
  const vivas = filas.filter((f) => esperadoEnMesCerrado(f.rubro ?? '', f.mes, mesActual, f.meses_con_gasto, f.meses_con_datos)
    // "Feriados" (sueldos) solo en meses con feriados. Año sin calendario: se muestra.
    && !(esConceptoFeriado(f.concepto) && feriadosDelMes(f.mes)?.length === 0));
  const ids = [...new Set(vivas.map((f) => f.proveedor_id).filter((x) => x != null))];
  const [ya, mo] = objetivo[objetivo.length - 1].split('-').map(Number);
  const t = ya * 12 + (mo - 1) - 6;
  const desde = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`;
  const compras = ids.length ? await db.many(queCompraSql({ organizationId, businessId, ids, desde })) : [];
  const queCompra = new Map();
  for (const id of ids) {
    const de = compras.filter((c) => c.pid === id);
    const a = (tipo) => de.filter((c) => c.tipo === tipo).map((c) => ({ txt: c.txt, obs: c.obs, imp: Number(c.imp) }));
    queCompra.set(id, resumenCompra(a('i'), a('c')));
  }
  const meses = objetivo.map((m) => ({ mes: m.slice(0, 7), items: [] }));
  for (const f of vivas) {
    const vence = venceEl(f.mes, f.dia, f.vencido);
    meses.find((x) => x.mes === f.mes)?.items.push({
      clave: f.clave,
      nombre: f.proveedor ?? f.concepto ?? f.clave,
      detalle: f.proveedor ? (f.concepto ?? '') : f.vencido ? 'sueldos del período' : 'gasto vario',
      rubro: f.rubro ?? 'Sin Rubro',
      ultimo: Number(f.ultimo), ultimoTotal: Number(f.ultimo_total ?? f.ultimo), pdvOrigenId: f.pdv_origen ?? null,
      dia: f.dia, vencido: f.vencido,
      proveedorId: f.proveedor_id ?? null, conceptoCodigo: f.concepto_codigo ?? null,
      vence, atrasado: estaAtrasado(vence, hoy),
      queCompra: f.proveedor_id != null ? queCompra.get(f.proveedor_id) ?? null : null,
    });
  }
  return { hoy, meses, descartes };
}

const descarteSchema = z.object({
  clave: z.string().regex(/^[pc]:[^\s@]{1,40}(@\d{4}-\d{2})?$/),
  nombre: z.string().max(200).optional().nullable(),
});

// "a:" = de ARCA, no se carga; "k:" = revisado, está bien. Son de la empresa, no de un lugar.
const descarteArcaSchema = z.object({ clave: z.string().regex(/^[ak]:\d{11}-\d{1,3}-\d{1,5}-\d{1,8}$/), nombre: z.string().max(200).optional().nullable() });

async function crearDescarte({ organizationId, businessId, sucursal, usuario, body }) {
  const deArca = descarteArcaSchema.safeParse(body);
  if (deArca.success) {
    const negocio = await db.one(sql`SELECT MIN(id) AS id FROM app_businesses WHERE organization_id = ${organizationId}`);
    const d = await db.one(sql`
      INSERT INTO gestion_sin_carga_descartes (business_id, branch_id, clave, nombre, "creadoPor")
      VALUES (${negocio.id}::bigint, NULL, ${deArca.data.clave}, ${deArca.data.nombre ?? null}, ${usuario})
      ON CONFLICT (business_id, branch_id, clave) DO UPDATE SET clave = EXCLUDED.clave
      RETURNING id`);
    return { ok: true, id: d.id };
  }
  exigirSucursal(sucursal);
  const b = descarteSchema.safeParse(body);
  if (!b.success) throw rechazo('Datos inválidos');
  const d = await db.one(sql`
    INSERT INTO gestion_sin_carga_descartes (business_id, branch_id, clave, nombre, "creadoPor")
    VALUES (${businessId}, ${sucursal}::bigint, ${b.data.clave}, ${b.data.nombre ?? null}, ${usuario})
    ON CONFLICT (business_id, branch_id, clave) DO UPDATE SET clave = EXCLUDED.clave
    RETURNING id`);
  return { ok: true, id: d.id };
}

async function borrarDescarte({ organizationId, businessId, id }) {
  if (!Number.isInteger(id) || id <= 0) throw rechazo('Datos inválidos');
  await db.execute(sql`
    DELETE FROM gestion_sin_carga_descartes WHERE id = ${id}
      AND (business_id = ${businessId} OR (clave ~ '^[ak]:' AND business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId})))`);
  return { ok: true };
}

// ── Impagas ───────────────────────────────────────────────────────────
// Un rubro cuenta como "apagado" solo si está apagado en Compras Y en Resultados: si se ve en
// alguno de los dos tableros, es un gasto real.
const rubroEncendidoSql = (businessId) => sql`
  (CASE WHEN rc.codigo IS NULL
    THEN (${sinRubroVisibleSql('visibleEnDashboard', businessId)} OR ${sinRubroVisibleSql('visibleEnResultados', businessId)})
    ELSE (${rubroVisibleSql('visibleEnDashboard')} OR ${rubroVisibleSql('visibleEnResultados')}) END)`;

// Un comprobante = (lugar, comprobante, proveedor): el 14 trae una factura partida en varias filas.
// Fuera: filas sin comprobante y los números internos E/G del kit para gastos varios.
function impagasSql({ organizationId, businessId, sucursal, desde }) {
  const visible = rubroEncendidoSql(businessId);
  const esPercepcion = sql`(COALESCE(cc.nombre, c.concepto, '') ILIKE '%percep%')`;
  return sql`
    WITH f AS (
      SELECT
        c.comprobante,
        c.codigo                                                   AS cod_pro,
        MAX(COALESCE(p.nombre, c.proveedor, c.codigo))             AS proveedor,
        MAX(c."proveedorId")                                       AS proveedor_id,
        BOOL_OR(COALESCE(p."pagoAutomatico", false))               AS pago_automatico,
        TO_CHAR(MIN(c.fecha), 'YYYY-MM-DD')                        AS fecha,
        SUM(COALESCE(c."importeManual", c.importe))                AS total14,
        COALESCE(BOOL_AND(NOT ${visible}) FILTER (WHERE NOT ${esPercepcion}), false) AS oculto,
        STRING_AGG(DISTINCT COALESCE(rc.nombre, 'Sin Rubro'), ', ') FILTER (WHERE NOT ${visible} AND NOT ${esPercepcion}) AS rubros_ocultos,
        STRING_AGG(DISTINCT COALESCE(cc.nombre, c.concepto), ' · ') AS conceptos
      FROM gestion_compras c
      LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId} AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = cc.codigo
      LEFT JOIN gestion_rubros_concepto_caja rc ON rc.organization_id = ${organizationId} AND cc."codRga" = rc.codigo
      LEFT JOIN gestion_rubros_visibilidad rv ON rv.business_id = ${businessId} AND rv.codigo = rc.codigo
      LEFT JOIN gestion_proveedores p ON p.id = c."proveedorId"
      WHERE ${enLugar('c', businessId, sucursal)}
        AND c.comprobante IS NOT NULL
        AND c.codigo IS NOT NULL
        AND UPPER(LEFT(c.comprobante, 1)) NOT IN ('E', 'G')
        AND c.fecha >= ${desde}::date
        AND c.fecha < NOW() + INTERVAL '60 days'
      GROUP BY c.comprobante, c.codigo
    ),
    pg AS (
      SELECT comprobante, "codPro", SUM(importe) AS pagado, MAX(total) AS total80,
        JSON_AGG(JSON_BUILD_OBJECT(
          'fecha', TO_CHAR(COALESCE("fechaPagoManual", "fechaPago"), 'YYYY-MM-DD'), 'importe', importe::float8, 'medio', medio, 'orden', orden
        ) ORDER BY COALESCE("fechaPagoManual", "fechaPago"), secuencia) AS pagos
      FROM gestion_pagos g
      WHERE ${enLugar('g', businessId, sucursal)}
      GROUP BY comprobante, "codPro"
    ),
    -- Pagos cargados en Lazarillo: se combinan abajo con los del 80.
    lz AS (
      SELECT a.comprobante, a."codPro",
        JSON_AGG(JSON_BUILD_OBJECT('fecha', TO_CHAR(pp.fecha, 'YYYY-MM-DD'), 'importe', a.importe::float8, 'medio', pp.medio, 'pagoId', pp.id)
          ORDER BY pp.fecha, pp.id) AS pagos_lz
      FROM gestion_aplicaciones_pago_proveedor a
      JOIN gestion_pagos_proveedor pp ON pp.id = a."pagoId" AND pp."anuladoEn" IS NULL
      WHERE ${enLugar('a', businessId, sucursal)}
      GROUP BY a.comprobante, a."codPro"
    )
    SELECT
      f.comprobante, f.cod_pro, f.proveedor, f.proveedor_id, f.fecha,
      COALESCE(pg.total80, f.total14)::float8 AS total,
      COALESCE(pg.pagado, 0)::float8 AS pagado,
      CASE WHEN f.oculto THEN COALESCE(f.rubros_ocultos, 'Rubro oculto') END AS rubro_oculto,
      f.pago_automatico,
      (fz.id IS NOT NULL) AS forzada,
      f.conceptos, pg.pagos, lz.pagos_lz
    FROM f
    LEFT JOIN pg ON pg.comprobante = f.comprobante AND pg."codPro" = f.cod_pro
    LEFT JOIN lz ON lz.comprobante = f.comprobante AND lz."codPro" = f.cod_pro
    LEFT JOIN gestion_impagas_forzadas fz
      ON ${enLugar('fz', businessId, sucursal)} AND fz.comprobante = f.comprobante AND fz."codPro" = f.cod_pro
    WHERE ABS(COALESCE(pg.total80, f.total14) - COALESCE(pg.pagado, 0)) > 1
    ORDER BY f.fecha`;
}

// Compras de OTRO lugar aperturadas a este (su parte), con lo que ya se le pagó al origen.
// Sin motor de apertura todavía (bloque 4) esto viene vacío, salvo datos ya repartidos.
function movimientosAperturaSql({ organizationId, businessId, sucursal, desde }) {
  const visible = rubroEncendidoSql(businessId);
  return sql`
    SELECT
      c."rowId"                                               AS key,
      ${lugarSql('c')}                                        AS pdv_origen_id,
      TO_CHAR(COALESCE(c."fechaManual", c.fecha), 'YYYY-MM-DD') AS fecha,
      c.comprobante,
      COALESCE(p.nombre, NULLIF(TRIM(CONCAT_WS(' ', e.nombre, e.apellido)), ''), c.proveedor, c.codigo) AS proveedor,
      (e.id IS NOT NULL)                                      AS es_empleado,
      COALESCE(cc.nombre, c.concepto)                         AS concepto,
      rc.nombre                                               AS rubro,
      MAX(da.porcentaje)::float8                              AS porcentaje,
      SUM(da."importeCalculado")::float8                      AS importe,
      COALESCE(c."importeManual", c.importe)::float8          AS total_compra,
      COALESCE(ap.aplicado, 0)::float8                        AS aplicado,
      ap.ops
    FROM gestion_distribuciones_apertura da
    JOIN gestion_destinos_regla d ON d.id = da."destinoId"
    JOIN gestion_compras c ON c.business_id = da.compra_business_id AND c."rowId" = da."compraRowId"
    LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId} AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = cc.codigo
    LEFT JOIN gestion_rubros_concepto_caja rc ON rc.organization_id = ${organizationId} AND cc."codRga" = rc.codigo
    LEFT JOIN gestion_rubros_visibilidad rv ON rv.business_id = ${businessId} AND rv.codigo = rc.codigo
    LEFT JOIN gestion_proveedores p ON p.id = c."proveedorId"
    LEFT JOIN gestion_empleados e ON c."proveedorId" IS NULL
                                 AND e.business_id = c.business_id AND e.branch_id IS NOT DISTINCT FROM c.branch_id
                                 AND e.codigo = c.codigo
                                 AND LOWER(TRIM(e.nombre)) = LOWER(TRIM(c.proveedor))
    LEFT JOIN LATERAL (
      SELECT SUM(a.importe) AS aplicado, ARRAY_AGG(DISTINCT a."pagoId" ORDER BY a."pagoId") AS ops
      FROM gestion_aplicaciones_pago_interno a
      JOIN gestion_pagos_internos pi ON pi.id = a."pagoId"
      WHERE a.compra_business_id = c.business_id AND a."compraRowId" = c."rowId"
        AND pi.destino_business_id = ${businessId} AND pi.destino_branch_id IS NOT DISTINCT FROM ${sucursal}::bigint
    ) ap ON TRUE
    WHERE ${enLugar('d', businessId, sucursal)}
      AND NOT (${enLugar('c', businessId, sucursal)})
      AND COALESCE(c."fechaManual", c.fecha) >= ${desde}::date
      AND COALESCE(c."fechaManual", c.fecha) < NOW() + INTERVAL '60 days'
      AND ${visible}
    GROUP BY c."rowId", c.business_id, c.branch_id, c."fechaManual", c.fecha, c.comprobante, p.nombre, c.proveedor, c.codigo, cc.nombre, c.concepto, rc.nombre, e.id, e.nombre, e.apellido, c."importeManual", c.importe, ap.aplicado, ap.ops
    HAVING ABS(SUM(da."importeCalculado")) > 0.5
    ORDER BY 3, 1`;
}

function pagosInternosSql({ businessId, sucursal }) {
  return sql`
    SELECT pi.id, ${lugarSql('pi', 'origen_business_id', 'origen_branch_id')} AS pdv_origen_id, TO_CHAR(pi.fecha, 'YYYY-MM-DD') AS fecha,
           pi.importe::float8 AS importe, pi.medio, pi.referencia,
           COALESCE(SUM(a.importe), 0)::float8 AS aplicado, COUNT(a.id)::int AS movimientos
    FROM gestion_pagos_internos pi
    LEFT JOIN gestion_aplicaciones_pago_interno a ON a."pagoId" = pi.id
    WHERE pi.destino_business_id = ${businessId} AND pi.destino_branch_id IS NOT DISTINCT FROM ${sucursal}::bigint AND pi."anuladoEn" IS NULL
    GROUP BY pi.id
    ORDER BY pi.fecha DESC, pi.id DESC`;
}

async function obtenerImpagas({ organizationId, businessId, sucursal, sp }) {
  exigirSucursal(sucursal);
  const desde = impagasDesde(sp.get('desde'), process.env.IMPAGAS_DESDE);
  const pdvId = idLugar(businessId, sucursal);
  const [rows, movs, pagos] = await Promise.all([
    db.many(impagasSql({ organizationId, businessId, sucursal, desde })),
    db.many(movimientosAperturaSql({ organizationId, businessId, sucursal, desde })),
    db.many(pagosInternosSql({ businessId, sucursal })),
  ]);
  const data = rows.map((r) => {
    // Pagos del 80 + los cargados en Lazarillo (el mismo pago en los dos lados cuenta una vez).
    const total = Number(r.total);
    const p80 = (r.pagos ?? []).map((x) => ({ fecha: x.fecha, importe: Number(x.importe) }));
    const plz = r.pagos_lz ?? [];
    const comb = combinarPagos(p80, plz.map((x) => ({ fecha: x.fecha, importe: Number(x.importe) })), total);
    return {
      id: `${pdvId}|${r.comprobante}|${r.cod_pro}`,
      pdvId,
      comprobante: r.comprobante,
      codPro: r.cod_pro,
      proveedor: r.proveedor?.trim() || `Proveedor ${r.cod_pro}`,
      proveedorId: r.proveedor_id,
      fecha: r.fecha,
      total,
      pagado: comb.pagado,
      rubroOculto: r.rubro_oculto,
      pagoAutomatico: r.pago_automatico,
      forzada: r.forzada,
      conceptos: r.conceptos ?? '',
      pagos: [
        ...(r.pagos ?? []),
        ...plz.filter((_, i) => !comb.conciliados.includes(i)).map((x) => ({ fecha: x.fecha, importe: Number(x.importe), medio: `${x.medio} · Lazarillo`, orden: null })),
      ].sort((a, b) => a.fecha.localeCompare(b.fecha)),
    };
  }).filter((c) => Math.abs(c.total - c.pagado) > 1); // pagadas con pagos de Lazarillo: fuera
  const deudas = new Map();
  const deuda = (id) => {
    if (!deudas.has(id)) deudas.set(id, { pdvOrigenId: id, movimientos: [], pagos: [] });
    return deudas.get(id);
  };
  for (const m of movs) {
    deuda(m.pdv_origen_id).movimientos.push({
      key: m.key, fecha: m.fecha, comprobante: m.comprobante,
      proveedor: m.proveedor?.trim() || '—', concepto: m.concepto?.trim() || '',
      porcentaje: Number(m.porcentaje), importe: Number(m.importe), aplicado: Number(m.aplicado),
      totalCompra: m.total_compra == null ? undefined : Number(m.total_compra),
      esEmpleado: m.es_empleado, ops: m.ops ?? [], rubro: m.rubro?.trim() || 'Sin rubro',
    });
  }
  for (const p of pagos) {
    deuda(p.pdv_origen_id).pagos.push({
      id: p.id, fecha: p.fecha, importe: Number(p.importe), medio: p.medio, referencia: p.referencia,
      aplicado: Number(p.aplicado), movimientos: Number(p.movimientos),
    });
  }
  return { desde, data, deudas: [...deudas.values()] };
}

const forzadasSchema = z.object({
  items: z.array(z.object({ pdvId: z.number().int(), comprobante: z.string().min(1), codPro: z.string().min(1) })).min(1).max(2000),
});

async function leerForzadas(businessId, body) {
  const b = forzadasSchema.safeParse(body);
  if (!b.success) throw rechazo('Datos inválidos');
  const lugares = await mapaLugares(db, businessId);
  if (b.data.items.some((i) => !lugares.has(i.pdvId))) throw rechazo('Sucursal inexistente');
  return b.data.items.map((i) => ({ ...i, branchId: lugares.get(i.pdvId).branchId }));
}

// Pasar a Impagas aunque tengan motivo de exclusión.
async function crearForzadas({ businessId, body }) {
  const items = await leerForzadas(businessId, body);
  const count = await db.execute(sql`
    INSERT INTO gestion_impagas_forzadas (business_id, branch_id, comprobante, "codPro")
    VALUES ${sql.join(items.map((i) => sql`(${businessId}, ${i.branchId}::bigint, ${i.comprobante}, ${i.codPro})`), ", ")}
    ON CONFLICT (business_id, branch_id, comprobante, "codPro") DO NOTHING`);
  return { ok: true, count };
}

// Volver a excluir.
async function borrarForzadas({ businessId, body }) {
  const items = await leerForzadas(businessId, body);
  let count = 0;
  await db.transaction(async (tx) => {
    for (const i of items) {
      count += await tx.execute(sql`
        DELETE FROM gestion_impagas_forzadas
        WHERE business_id = ${businessId} AND branch_id IS NOT DISTINCT FROM ${i.branchId}::bigint AND comprobante = ${i.comprobante} AND "codPro" = ${i.codPro}`);
    }
  });
  return { ok: true, count };
}

// El proveedor cobra solo (débito, retención): todas sus facturas, también las futuras, quedan en
// Excluidas. Al marcarlo se limpian las que se habían pasado a mano a Impagas en este negocio.
async function cambiarPagoAutomatico({ organizationId, businessId, body }) {
  const b = z.object({ proveedorId: z.number().int().positive(), pagoAutomatico: z.boolean() }).safeParse(body);
  if (!b.success) throw rechazo('Datos inválidos');
  return db.transaction(async (tx) => {
    const prov = await tx.one(sql`
      UPDATE gestion_proveedores SET "pagoAutomatico" = ${b.data.pagoAutomatico}
      WHERE id = ${b.data.proveedorId} AND organization_id = ${organizationId} RETURNING codigo`);
    if (!prov) throw rechazo('Proveedor inexistente', 404);
    if (b.data.pagoAutomatico) {
      await tx.execute(sql`DELETE FROM gestion_impagas_forzadas WHERE business_id = ${businessId} AND "codPro" = ${prov.codigo}`);
    }
    return { ok: true };
  });
}

// Un pago de MaxiRest (informe 80) = misma orden + mismo día en el lugar. Solo lectura.
async function obtenerOpMaxirest({ businessId, sucursal, sp }) {
  exigirSucursal(sucursal);
  const orden = (sp.get('orden') ?? '').trim();
  const fecha = sp.get('fecha') ?? '';
  if (!orden || orden.length > 40 || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw rechazo('Datos inválidos');
  const [rows, fechas] = await Promise.all([
    db.many(sql`
      SELECT comprobante, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, proveedor, concepto, total::float8 AS total, importe::float8 AS importe, medio
      FROM gestion_pagos g
      WHERE ${enLugar('g', businessId, sucursal)} AND orden = ${orden} AND "fechaPago"::date = ${fecha}::date
      ORDER BY fecha, comprobante, secuencia`),
    db.many(sql`
      SELECT TO_CHAR("fechaPago", 'YYYY-MM-DD') AS fecha, SUM(importe)::float8 AS importe, COUNT(DISTINCT comprobante)::int AS comprobantes
      FROM gestion_pagos g
      WHERE ${enLugar('g', businessId, sucursal)} AND orden = ${orden} AND "fechaPago" IS NOT NULL
      GROUP BY 1 ORDER BY 1`),
  ]);
  if (!rows.length) throw rechazo('No existe', 404);
  const comprobantes = rows.map((r) => ({
    comprobante: r.comprobante, fecha: r.fecha, proveedor: r.proveedor?.trim() || '—',
    concepto: r.concepto?.trim() || '', total: r.total == null ? null : Number(r.total), importe: Number(r.importe),
  }));
  return {
    orden, fecha,
    medios: [...new Set(rows.map((r) => r.medio).filter(Boolean))],
    importe: Math.round(comprobantes.reduce((s, c) => s + c.importe, 0) * 100) / 100,
    comprobantes,
    fechas: fechas.map((f) => ({ fecha: f.fecha, importe: Number(f.importe), comprobantes: Number(f.comprobantes) })),
  };
}

// ── Órdenes de pago entre lugares (deuda por aperturas) ───────────────
const eventoInterno = (tx, e) => tx.execute(sql`
  INSERT INTO gestion_eventos_pago_interno ("pagoId", tipo, detalle, importe, usuario)
  VALUES (${e.pagoId}, ${e.tipo}, ${e.detalle ?? null}, ${e.importe ?? null}::numeric, ${e.usuario ?? null})`);

const opSchema = z.object({
  pdvOrigenId: z.number().int(),
  fecha: fechaISO,
  medio: z.string().trim().min(1).max(40).optional(),
  referencia: z.string().max(200).optional().nullable(),
  // Pago libre (sin keys): importe; queda como OP sin imputar.
  importe: z.number().positive().optional(),
  desde: z.string().optional(),
  // Elegidos: sin importe se salda cada uno entero; con importe, del más viejo al más nuevo.
  keys: z.array(z.string().min(1)).max(10000).optional(),
  // Usar el disponible de una orden existente en vez de crear otra.
  usarOp: z.number().int().positive().optional(),
})
  .refine((b) => (b.keys?.length ?? 0) > 0 || b.importe !== undefined, { message: 'importe o keys' })
  .refine((b) => b.usarOp !== undefined || b.medio !== undefined, { message: 'medio' });

async function movimientosDeOrigen(cliente, ctx, pdvOrigenId, desde) {
  return (await cliente.many(movimientosAperturaSql({ ...ctx, desde })))
    .filter((m) => m.pdv_origen_id === pdvOrigenId)
    .map((m) => ({ key: m.key, fecha: m.fecha, importe: Number(m.importe), aplicado: Number(m.aplicado) }));
}

async function insertarAplicacionesOp(tx, pagoId, compraBusinessId, aplicaciones) {
  if (!aplicaciones.length) return;
  await tx.execute(sql`
    INSERT INTO gestion_aplicaciones_pago_interno ("pagoId", compra_business_id, "compraRowId", importe)
    VALUES ${sql.join(aplicaciones.map((a) => sql`(${pagoId}, ${compraBusinessId}, ${a.key}, ${a.importe}::numeric)`), ", ")}`);
}

// Una orden de pago en la que este lugar es el que paga.
async function opDelLugar(cliente, { organizationId, businessId }, id) {
  const p = await cliente.one(sql`
    SELECT * FROM gestion_pagos_internos WHERE id = ${id} AND organization_id = ${organizationId} AND destino_business_id = ${businessId}`);
  if (!p) return null;
  return { ...p, id: Number(p.id), importeN: Number(p.importe), fechaIso: p.fecha instanceof Date ? p.fecha.toISOString().slice(0, 10) : String(p.fecha).slice(0, 10) };
}
const lugarOrigenDe = (p) => idLugar(p.origen_business_id, p.origen_branch_id);

async function crearOp({ organizationId, businessId, sucursal, usuario, body }) {
  exigirSucursal(sucursal);
  const parsed = opSchema.safeParse(body);
  if (!parsed.success) throw rechazo('Datos inválidos');
  const b = parsed.data;
  const destino = idLugar(businessId, sucursal);
  if (b.pdvOrigenId === destino) throw rechazo('Datos inválidos');
  const origen = await lugarDeOrganizacion(db, organizationId, b.pdvOrigenId);
  if (!origen) throw rechazo('Ese lugar no existe');
  const ctx = { organizationId, businessId, sucursal };

  // Imputar lo que quedó a cuenta de una orden existente: no crea otra.
  if (b.usarOp !== undefined) {
    const pago = await opDelLugar(db, ctx, b.usarOp);
    if (!pago || pago.anuladoEn || lugarOrigenDe(pago) !== b.pdvOrigenId || (pago.destino_branch_id == null ? null : Number(pago.destino_branch_id)) !== sucursal) {
      throw rechazo('Esa orden de pago no corresponde a este lugar.', 404);
    }
    const ya = await db.one(sql`SELECT COALESCE(SUM(importe), 0)::float8 AS n FROM gestion_aplicaciones_pago_interno WHERE "pagoId" = ${pago.id}`);
    const disponible = redondear(pago.importeN - Number(ya.n));
    if (disponible <= 0.005) throw rechazo(`${numeroOP(pago.id)} no tiene saldo disponible.`);
    if (b.importe !== undefined && redondear(b.importe) > disponible + 0.005) throw rechazo(`${numeroOP(pago.id)} tiene ${fmtPesos(disponible)} disponibles.`);
    const desde = b.keys?.length ? '1900-01-01' : impagasDesde(b.desde, process.env.IMPAGAS_DESDE);
    const movs = await movimientosDeOrigen(db, ctx, b.pdvOrigenId, desde);
    // Si no alcanza, salda lo que da (lo más viejo primero).
    const monto = redondear(Math.min(b.importe ?? disponible, disponible));
    const { aplicaciones } = b.keys?.length ? imputarElegidos(movs, b.keys, monto) : imputarFifo(movs, monto);
    const aplicado = redondear(aplicaciones.reduce((s, a) => s + a.importe, 0));
    if (aplicado <= 0) throw rechazo('No hay saldo para imputar.');
    await db.transaction(async (tx) => {
      await insertarAplicacionesOp(tx, pago.id, origen.businessId, aplicaciones);
      await eventoInterno(tx, {
        pagoId: pago.id, tipo: 'imputada', importe: aplicado, usuario,
        detalle: `a ${aplicaciones.length} movimiento${aplicaciones.length === 1 ? '' : 's'}`,
      });
    });
    return { ok: true, id: pago.id, usada: true, aplicado, disponible: redondear(disponible - aplicado) };
  }

  if (!(await medioValido(db, businessId, b.medio))) throw rechazo('Ese medio de pago no existe o está desactivado.');
  const referencia = referenciaDe(b.referencia);
  if (referencia && await referenciaRepetida(db, organizationId, referencia)) throw rechazo('Ese ID de transferencia ya está cargado.', 409);

  const desde = b.keys?.length ? '1900-01-01' : impagasDesde(b.desde, process.env.IMPAGAS_DESDE);
  const movs = await movimientosDeOrigen(db, ctx, b.pdvOrigenId, desde);
  let importe;
  let aplicaciones;
  if (b.keys?.length && b.importe === undefined) {
    aplicaciones = imputarElegidos(movs, b.keys).aplicaciones;
    importe = redondear(aplicaciones.reduce((s, a) => s + a.importe, 0));
    if (importe <= 0) throw rechazo('No hay saldo para saldar.');
  } else if (b.keys?.length) {
    importe = redondear(b.importe);
    aplicaciones = imputarElegidos(movs, b.keys, importe).aplicaciones;
  } else {
    importe = redondear(b.importe);
    aplicaciones = [];
  }
  try {
    const id = await db.transaction(async (tx) => {
      const p = await tx.one(sql`
        INSERT INTO gestion_pagos_internos (organization_id, origen_business_id, origen_branch_id, destino_business_id, destino_branch_id, fecha, importe, medio, referencia, "creadoPor")
        VALUES (${organizationId}, ${origen.businessId}, ${origen.branchId}::bigint, ${businessId}, ${sucursal}::bigint, ${b.fecha}::date, ${importe}::numeric, ${b.medio}, ${referencia}, ${usuario})
        RETURNING id`);
      await insertarAplicacionesOp(tx, p.id, origen.businessId, aplicaciones);
      await eventoInterno(tx, {
        pagoId: p.id, tipo: 'creada', importe, usuario,
        detalle: `${b.medio}${referencia ? ` · ID ${referencia}` : ''} · ${aplicaciones.length ? `imputada a ${aplicaciones.length} movimiento${aplicaciones.length === 1 ? '' : 's'}` : 'sin imputar'}`,
      });
      return p.id;
    });
    const aplicado = redondear(aplicaciones.reduce((s, a) => s + a.importe, 0));
    return { ok: true, id, importe, aplicado, aCuenta: redondear(importe - aplicado) };
  } catch (err) {
    if (err?.code === '23505') throw rechazo('Ese ID de transferencia ya está cargado.', 409);
    throw err;
  }
}

const opPatchSchema = z.object({
  fecha: fechaISO,
  medio: z.string().trim().min(1).max(40),
  referencia: z.string().max(200).optional().nullable(),
  importe: z.number().positive(),
});

// Si cambia el importe se vuelve a imputar a los mismos movimientos; lo que no entra queda a cuenta.
async function editarOp({ organizationId, businessId, usuario, id, body }) {
  if (!Number.isInteger(id) || id <= 0) throw rechazo('id inválido');
  const parsed = opPatchSchema.safeParse(body);
  if (!parsed.success) throw rechazo('Datos inválidos');
  const b = parsed.data;
  const ctx = { organizationId, businessId };
  const pago = await opDelLugar(db, ctx, id);
  if (!pago || pago.anuladoEn) throw rechazo('Esa orden de pago ya no existe o está anulada.', 404);
  if (!(await medioValido(db, businessId, b.medio, pago.medio))) throw rechazo('Ese medio de pago no existe o está desactivado.');
  const referencia = referenciaDe(b.referencia);
  if (referencia) {
    const otra = await db.one(sql`SELECT id FROM gestion_pagos_internos WHERE organization_id = ${organizationId} AND referencia = ${referencia}`);
    if (otra && Number(otra.id) !== id) throw rechazo('Ese ID de transferencia ya está cargado.', 409);
  }
  const importe = redondear(b.importe);
  const cambiaImporte = Math.abs(importe - pago.importeN) > 0.005;
  const sucursal = pago.destino_branch_id == null ? null : Number(pago.destino_branch_id);
  try {
    await db.transaction(async (tx) => {
      if (cambiaImporte) {
        const antes = [...new Set((await tx.many(sql`SELECT "compraRowId" FROM gestion_aplicaciones_pago_interno WHERE "pagoId" = ${id}`)).map((a) => a.compraRowId))];
        await tx.execute(sql`DELETE FROM gestion_aplicaciones_pago_interno WHERE "pagoId" = ${id}`);
        const movs = await movimientosDeOrigen(tx, { organizationId, businessId, sucursal }, lugarOrigenDe(pago), '1900-01-01');
        const { aplicaciones } = imputarElegidos(movs, antes, importe);
        await insertarAplicacionesOp(tx, id, pago.origen_business_id, aplicaciones);
      }
      await tx.execute(sql`
        UPDATE gestion_pagos_internos SET fecha = ${b.fecha}::date, medio = ${b.medio}, referencia = ${referencia}, importe = ${importe}::numeric
        WHERE id = ${id}`);
      const cambios = [];
      if (cambiaImporte) cambios.push(`importe ${fmtPesos(pago.importeN)} → ${fmtPesos(importe)}`);
      if (pago.fechaIso !== b.fecha) cambios.push(`fecha ${fmtFecha(pago.fechaIso)} → ${fmtFecha(b.fecha)}`);
      if (pago.medio !== b.medio) cambios.push(`medio ${pago.medio} → ${b.medio}`);
      if ((pago.referencia ?? null) !== referencia) cambios.push(referencia ? `ID ${referencia}` : 'sin ID');
      await eventoInterno(tx, { pagoId: id, tipo: 'editada', importe, usuario, detalle: cambios.length ? cambios.join(' · ') : 'sin cambios' });
    });
    return { ok: true };
  } catch (err) {
    if (err?.code === '23505') throw rechazo('Ese ID de transferencia ya está cargado.', 409);
    throw err;
  }
}

// La orden con sus imputaciones, y Anterior / Siguiente del mismo par de lugares.
const aplicacionesOpSql = (organizationId, pagoId) => sql`
  SELECT
    c."rowId" AS key,
    TO_CHAR(COALESCE(c."fechaManual", c.fecha), 'YYYY-MM-DD') AS fecha,
    c.comprobante,
    COALESCE(p.nombre, NULLIF(TRIM(CONCAT_WS(' ', e.nombre, e.apellido)), ''), c.proveedor, c.codigo) AS proveedor,
    COALESCE(cc.nombre, c.concepto) AS concepto,
    SUM(a.importe)::float8 AS importe
  FROM gestion_aplicaciones_pago_interno a
  JOIN gestion_compras c ON c.business_id = a.compra_business_id AND c."rowId" = a."compraRowId"
  LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId} AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = cc.codigo
  LEFT JOIN gestion_proveedores p ON p.id = c."proveedorId"
  LEFT JOIN gestion_empleados e ON c."proveedorId" IS NULL
                               AND e.business_id = c.business_id AND e.branch_id IS NOT DISTINCT FROM c.branch_id
                               AND e.codigo = c.codigo AND LOWER(TRIM(e.nombre)) = LOWER(TRIM(c.proveedor))
  WHERE a."pagoId" = ${pagoId}
  GROUP BY c."rowId", c."fechaManual", c.fecha, c.comprobante, p.nombre, e.nombre, e.apellido, c.proveedor, c.codigo, cc.nombre, c.concepto
  ORDER BY 2 DESC, 1`;

async function obtenerOp({ organizationId, businessId, id }) {
  if (!Number.isInteger(id) || id <= 0) throw rechazo('id inválido');
  const pago = await opDelLugar(db, { organizationId, businessId }, id);
  if (!pago) throw rechazo('No existe', 404);
  const aplicaciones = (await db.many(aplicacionesOpSql(organizationId, id))).map((a) => ({
    key: a.key, fecha: a.fecha, comprobante: a.comprobante, proveedor: a.proveedor?.trim() || '—',
    concepto: a.concepto?.trim() || '', importe: Number(a.importe),
  }));
  const aplicado = redondear(aplicaciones.reduce((s, a) => s + a.importe, 0));
  const par = sql`
    organization_id = ${organizationId}
    AND origen_business_id = ${pago.origen_business_id} AND origen_branch_id IS NOT DISTINCT FROM ${pago.origen_branch_id}::bigint
    AND destino_business_id = ${pago.destino_business_id} AND destino_branch_id IS NOT DISTINCT FROM ${pago.destino_branch_id}::bigint`;
  const [anterior, siguiente] = await Promise.all([
    db.one(sql`SELECT id FROM gestion_pagos_internos WHERE ${par} AND id < ${id} ORDER BY id DESC LIMIT 1`),
    db.one(sql`SELECT id FROM gestion_pagos_internos WHERE ${par} AND id > ${id} ORDER BY id ASC LIMIT 1`),
  ]);
  const anulada = !!pago.anuladoEn;
  return {
    anteriorId: anterior?.id ?? null, siguienteId: siguiente?.id ?? null,
    anuladaEn: anulada ? new Date(pago.anuladoEn).toISOString() : null,
    id: pago.id, pdvOrigenId: lugarOrigenDe(pago), pdvDestinoId: idLugar(pago.destino_business_id, pago.destino_branch_id),
    fecha: pago.fechaIso, importe: pago.importeN, medio: pago.medio,
    referencia: pago.referencia, creadoPor: pago.creadoPor, creadoEn: new Date(pago.creadoEn).toISOString(),
    anulada, aplicado, disponible: anulada ? 0 : redondear(pago.importeN - aplicado), aplicaciones,
  };
}

// ANULAR: no se borra, queda en el historial. Los movimientos vuelven a quedar impagos y el ID se libera.
async function anularOp({ organizationId, businessId, usuario, id }) {
  if (!Number.isInteger(id) || id <= 0) throw rechazo('id inválido');
  const pago = await opDelLugar(db, { organizationId, businessId }, id);
  if (!pago || pago.anuladoEn) throw rechazo('No existe', 404);
  await db.transaction(async (tx) => {
    const { n } = await tx.one(sql`SELECT COUNT(DISTINCT "compraRowId")::int AS n FROM gestion_aplicaciones_pago_interno WHERE "pagoId" = ${id}`);
    await tx.execute(sql`DELETE FROM gestion_aplicaciones_pago_interno WHERE "pagoId" = ${id}`);
    await tx.execute(sql`UPDATE gestion_pagos_internos SET "anuladoEn" = CURRENT_TIMESTAMP, referencia = NULL WHERE id = ${id}`);
    await eventoInterno(tx, {
      pagoId: id, tipo: 'anulada', importe: pago.importeN, usuario,
      detalle: `${pago.medio}${pago.referencia ? ` · ID ${pago.referencia}` : ''} · ${n ? `tenía ${n} movimiento${n === 1 ? '' : 's'} imputado${n === 1 ? '' : 's'}` : 'sin imputar'}`,
    });
  });
  return { ok: true };
}

// Quitar imputaciones: el importe vuelve al movimiento y pasa al "sin imputar" de la orden.
async function desimputarOp({ organizationId, businessId, usuario, id, body }) {
  if (!Number.isInteger(id) || id <= 0) throw rechazo('id inválido');
  const parsed = z.object({ keys: z.array(z.string().min(1)).max(10000).optional() }).safeParse(body ?? {});
  if (!parsed.success) throw rechazo('Datos inválidos');
  const keys = parsed.data.keys?.length ? parsed.data.keys : null;
  const pago = await opDelLugar(db, { organizationId, businessId }, id);
  if (!pago || pago.anuladoEn) throw rechazo('Esa orden de pago no existe o está anulada.', 404);
  const actuales = (await db.many(aplicacionesOpSql(organizationId, id))).filter((a) => !keys || keys.includes(a.key));
  if (!actuales.length) throw rechazo('No hay imputaciones para quitar.');
  const total = redondear(actuales.reduce((s, a) => s + Number(a.importe), 0));
  const uno = actuales.length === 1 ? actuales[0] : null;
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM gestion_aplicaciones_pago_interno WHERE "pagoId" = ${id} AND "compraRowId" = ANY(${actuales.map((a) => a.key)}::text[])`);
    await eventoInterno(tx, {
      pagoId: id, tipo: 'desimputada', importe: total, usuario,
      detalle: uno
        ? `${fmtFecha(uno.fecha)} · ${uno.comprobante ? fmtComprobante(uno.comprobante) : uno.concepto ?? ''} · ${uno.proveedor ?? ''}`.trim()
        : keys ? `${actuales.length} movimientos` : `todas (${actuales.length} movimientos)`,
    });
  });
  return { ok: true, quitado: total, movimientos: actuales.length };
}

// Historial de las órdenes entre este lugar y otro.
async function historialOp({ organizationId, businessId, sucursal, sp }) {
  exigirSucursal(sucursal);
  const origen = await lugarDeOrganizacion(db, organizationId, Number(sp.get('pdvOrigenId')));
  if (!origen) throw rechazo('Datos inválidos');
  const rows = await db.many(sql`
    SELECT ev.id, ev."pagoId" AS pago_id, ev.tipo, ev.detalle, ev.importe::float8 AS importe, ev.usuario,
           TO_CHAR((ev."creadoEn" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY HH24:MI') AS cuando,
           (pi."anuladoEn" IS NOT NULL) AS anulada
    FROM gestion_eventos_pago_interno ev
    JOIN gestion_pagos_internos pi ON pi.id = ev."pagoId"
    WHERE pi.organization_id = ${organizationId}
      AND pi.destino_business_id = ${businessId} AND pi.destino_branch_id IS NOT DISTINCT FROM ${sucursal}::bigint
      AND pi.origen_business_id = ${origen.businessId} AND pi.origen_branch_id IS NOT DISTINCT FROM ${origen.branchId}::bigint
    ORDER BY ev."creadoEn" DESC, ev.id DESC
    LIMIT 500`);
  return {
    eventos: rows.map((r) => ({
      id: r.id, pagoId: r.pago_id, tipo: r.tipo, detalle: r.detalle,
      importe: r.importe == null ? null : Number(r.importe), usuario: r.usuario, cuando: r.cuando, anulada: r.anulada,
    })),
  };
}

// ── Saldos de un proveedor (14 + informe 80 + pagos de Lazarillo) ─────
async function saldosFacturas(cliente, businessId, codPro, facturas) {
  const res = new Map();
  if (!facturas.length) return res;
  const rows = await cliente.many(sql`
    WITH k AS (
      SELECT * FROM UNNEST(${facturas.map((f) => f.pdvId)}::int[], ${facturas.map((f) => f.comprobante)}::text[]) AS k(pdv, cpb)
    )
    SELECT k.pdv, k.cpb,
      (SELECT TO_CHAR(MIN(COALESCE(c."fechaManual", c.fecha)), 'YYYY-MM-DD') FROM gestion_compras c
        WHERE c.business_id = ${businessId} AND ${lugarSql('c')} = k.pdv AND c.comprobante = k.cpb AND c.codigo = ${codPro}) AS fecha14,
      (SELECT SUM(COALESCE(c."importeManual", c.importe))::float8 FROM gestion_compras c
        WHERE c.business_id = ${businessId} AND ${lugarSql('c')} = k.pdv AND c.comprobante = k.cpb AND c.codigo = ${codPro}) AS total14,
      (SELECT TO_CHAR(MIN(p.fecha), 'YYYY-MM-DD') FROM gestion_pagos p
        WHERE p.business_id = ${businessId} AND ${lugarSql('p')} = k.pdv AND p.comprobante = k.cpb AND p."codPro" = ${codPro}) AS fecha80,
      (SELECT MAX(p.total)::float8 FROM gestion_pagos p
        WHERE p.business_id = ${businessId} AND ${lugarSql('p')} = k.pdv AND p.comprobante = k.cpb AND p."codPro" = ${codPro}) AS total80,
      (SELECT JSON_AGG(JSON_BUILD_OBJECT('fecha', TO_CHAR(COALESCE(p."fechaPagoManual", p."fechaPago"), 'YYYY-MM-DD'), 'importe', p.importe::float8)) FROM gestion_pagos p
        WHERE p.business_id = ${businessId} AND ${lugarSql('p')} = k.pdv AND p.comprobante = k.cpb AND p."codPro" = ${codPro}) AS p80,
      (SELECT JSON_AGG(JSON_BUILD_OBJECT('fecha', TO_CHAR(pp.fecha, 'YYYY-MM-DD'), 'importe', a.importe::float8))
        FROM gestion_aplicaciones_pago_proveedor a JOIN gestion_pagos_proveedor pp ON pp.id = a."pagoId" AND pp."anuladoEn" IS NULL
        WHERE a.business_id = ${businessId} AND ${lugarSql('a')} = k.pdv AND a.comprobante = k.cpb AND a."codPro" = ${codPro}) AS plz
    FROM k`);
  for (const r of rows) {
    const total = Number(r.total80 ?? r.total14 ?? 0);
    const { pagado } = combinarPagos(r.p80 ?? [], r.plz ?? [], total);
    res.set(claveFactura(r.pdv, r.cpb), {
      key: claveFactura(r.pdv, r.cpb), pdvId: r.pdv, comprobante: r.cpb,
      fecha: r.fecha14 ?? r.fecha80 ?? '', total, pagado, saldo: Math.max(0, Math.round((total - pagado) * 100) / 100),
      existe: r.total14 != null || r.total80 != null,
    });
  }
  return res;
}

// Pagos vigentes del proveedor en este negocio con disponible (lo que no está imputado).
async function pagosACuenta(cliente, { organizationId, businessId }, codPro) {
  const rows = await cliente.many(sql`
    SELECT pp.id, TO_CHAR(pp.fecha, 'YYYY-MM-DD') AS fecha, pp.importe::float8 AS importe, pp.medio, pp.referencia, ${lugarSql('pp')} AS pdv,
      COALESCE((SELECT SUM(a.importe) FROM gestion_aplicaciones_pago_proveedor a WHERE a."pagoId" = pp.id), 0)::float8 AS aplicado
    FROM gestion_pagos_proveedor pp
    WHERE pp.organization_id = ${organizationId} AND pp.business_id = ${businessId} AND pp."codPro" = ${codPro} AND pp."anuladoEn" IS NULL
    ORDER BY pp.fecha, pp.id`);
  return rows
    .map((r) => ({ id: r.id, fecha: r.fecha, importe: Number(r.importe), medio: r.medio, referencia: r.referencia, pdvPagaId: r.pdv, disponible: Math.round((Number(r.importe) - Number(r.aplicado)) * 100) / 100 }))
    .filter((p) => p.disponible > 0.004);
}

// Un solo movimiento de pagos por proveedor a la vez (dos pestañas pagando lo mismo).
const bloquearProveedor = (tx, organizationId, codPro) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`pagos-proveedor:${organizationId}:${codPro}`}))`);

const eventoPago = (tx, pagoId, tipo, detalle, importe, usuario) => tx.execute(sql`
  INSERT INTO gestion_eventos_pago_proveedor ("pagoId", tipo, detalle, importe, usuario)
  VALUES (${pagoId}, ${tipo}, ${detalle}, ${importe ?? null}::numeric, ${usuario})`);

async function crearAplicaciones(tx, pagoId, businessId, lugares, codPro, aplicaciones) {
  if (!aplicaciones.length) return;
  await tx.execute(sql`
    INSERT INTO gestion_aplicaciones_pago_proveedor ("pagoId", business_id, branch_id, comprobante, "codPro", importe)
    VALUES ${sql.join(aplicaciones.map((a) => {
      const i = a.key.indexOf('|');
      const lugar = lugares.get(Number(a.key.slice(0, i)));
      return sql`(${pagoId}, ${businessId}, ${lugar.branchId}::bigint, ${a.key.slice(i + 1)}, ${codPro}, ${a.importe}::numeric)`;
    }), ", ")}`);
}

const pagoSchema = z.object({
  codPro: z.string().trim().min(1).max(40),
  pdvPagaId: z.number().int().optional(),
  fecha: fechaISO.optional(),
  medio: z.string().trim().min(1).max(40).optional(),
  referencia: z.string().max(200).optional().nullable(),
  // Sin facturas: pago a cuenta. Con facturas y sin importe: salda cada una entera.
  importe: z.number().positive().optional(),
  facturas: z.array(z.object({ pdvId: z.number().int(), comprobante: z.string().trim().min(1).max(40) })).max(500).optional(),
  // Usar el disponible de un pago a cuenta existente (no crea otro pago).
  usarPago: z.number().int().positive().optional(),
})
  .refine((b) => (b.facturas?.length ?? 0) > 0 || b.importe !== undefined, { message: 'importe o facturas' })
  .refine((b) => b.usarPago !== undefined || (b.medio !== undefined && b.fecha !== undefined && b.pdvPagaId !== undefined), { message: 'medio, fecha y lugar' });

async function registrarPago({ organizationId, businessId, usuario, body }) {
  const parsed = pagoSchema.safeParse(body);
  if (!parsed.success) throw rechazo('Datos inválidos');
  const b = parsed.data;
  return db.transaction(async (tx) => {
    await bloquearProveedor(tx, organizationId, b.codPro);
    const lugares = await mapaLugares(tx, businessId);
    const elegidas = [...new Map((b.facturas ?? []).map((f) => [claveFactura(f.pdvId, f.comprobante), f])).values()];
    if (elegidas.some((f) => !lugares.has(f.pdvId))) throw rechazo('Alguna factura elegida no existe.');
    const saldos = await saldosFacturas(tx, businessId, b.codPro, elegidas);
    if ([...saldos.values()].some((s) => !s.existe)) throw rechazo('Alguna factura elegida no existe.');
    const pendientes = [...saldos.values()].map((s) => ({ key: s.key, fecha: s.fecha, saldo: s.saldo }));
    if (elegidas.length && !pendientes.some((p) => p.saldo > 0.004)) throw rechazo('Esas facturas ya están pagas.');

    // Aplicar el disponible de un pago a cuenta.
    if (b.usarPago !== undefined) {
      const pago = await tx.one(sql`
        SELECT pp.id, pp.importe::float8 AS importe,
          COALESCE((SELECT SUM(a.importe) FROM gestion_aplicaciones_pago_proveedor a WHERE a."pagoId" = pp.id), 0)::float8 AS aplicado
        FROM gestion_pagos_proveedor pp
        WHERE pp.id = ${b.usarPago} AND pp.organization_id = ${organizationId} AND pp.business_id = ${businessId}
          AND pp."codPro" = ${b.codPro} AND pp."anuladoEn" IS NULL`);
      if (!pago) throw rechazo('Ese pago ya no existe o está anulado.');
      const disp = Number(pago.importe) - Number(pago.aplicado);
      if (disp <= 0.004) throw rechazo(`${numeroPago(pago.id)} no tiene disponible.`);
      const monto = Math.min(b.importe ?? disp, disp);
      const { aplicaciones } = imputarFacturas(pendientes, monto);
      await crearAplicaciones(tx, pago.id, businessId, lugares, b.codPro, aplicaciones);
      const aplicado = aplicaciones.reduce((s, a) => s + a.importe, 0);
      await eventoPago(tx, pago.id, 'imputado', `${aplicaciones.length} factura${aplicaciones.length === 1 ? '' : 's'}`, aplicado, usuario);
      return { id: pago.id, aplicado, aCuenta: Math.round((disp - aplicado) * 100) / 100 };
    }

    // Pago nuevo.
    if (!(await medioValido(tx, businessId, b.medio))) throw rechazo('Ese medio de pago no existe o está desactivado.');
    const paga = lugares.get(b.pdvPagaId);
    if (!paga) throw rechazo('Elegí qué sucursal paga.');
    const referencia = referenciaDe(b.referencia);
    if (referencia && await referenciaRepetida(tx, organizationId, referencia)) throw rechazo('Ese ID de transferencia ya está cargado.');
    const { aplicaciones, sobrante } = elegidas.length ? imputarFacturas(pendientes, b.importe) : { aplicaciones: [], sobrante: b.importe };
    const importe = Math.round((aplicaciones.reduce((s, a) => s + a.importe, 0) + sobrante) * 100) / 100;
    const pago = await tx.one(sql`
      INSERT INTO gestion_pagos_proveedor (organization_id, business_id, branch_id, "codPro", fecha, importe, medio, referencia, "creadoPor")
      VALUES (${organizationId}, ${businessId}, ${paga.branchId}::bigint, ${b.codPro}, ${b.fecha}::date, ${importe}::numeric, ${b.medio}, ${referencia}, ${usuario})
      RETURNING id`);
    await crearAplicaciones(tx, pago.id, businessId, lugares, b.codPro, aplicaciones);
    await eventoPago(tx, pago.id, 'creado',
      aplicaciones.length ? `${aplicaciones.length} factura${aplicaciones.length === 1 ? '' : 's'}${sobrante > 0.004 ? ` · ${fmtPesos(sobrante)} a cuenta` : ''}` : 'a cuenta',
      importe, usuario);
    return { id: pago.id, aplicado: importe - sobrante, aCuenta: sobrante };
  });
}

const leerPago = (cliente, { organizationId, businessId }, id) => cliente.one(sql`
  SELECT id, "codPro", TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, importe::float8 AS importe, medio, referencia, business_id, branch_id, "anuladoEn"
  FROM gestion_pagos_proveedor WHERE id = ${id} AND organization_id = ${organizationId} AND business_id = ${businessId}`);

const pagoPatchSchema = z.object({
  fecha: fechaISO,
  medio: z.string().trim().min(1).max(40),
  referencia: z.string().max(200).optional().nullable(),
  pdvPagaId: z.number().int(),
  importe: z.number().positive().optional(),
});

// Corregir fecha, medio, ID, quién paga e importe. Si sube, lo de más queda a cuenta; si baja y no
// alcanza para lo imputado, se suelta lo de las facturas más nuevas primero.
async function editarPago({ organizationId, businessId, usuario, id, body }) {
  if (!Number.isInteger(id) || id <= 0) throw rechazo('id inválido');
  const parsed = pagoPatchSchema.safeParse(body);
  if (!parsed.success) throw rechazo('Datos inválidos');
  const b = parsed.data;
  const ctx = { organizationId, businessId };
  const pago = await leerPago(db, ctx, id);
  if (!pago || pago.anuladoEn) throw rechazo('Ese pago ya no existe o está anulado.', 404);
  if (!(await medioValido(db, businessId, b.medio, pago.medio))) throw rechazo('Ese medio de pago no existe o está desactivado.');
  const lugares = await mapaLugares(db, businessId);
  const paga = lugares.get(b.pdvPagaId);
  if (!paga) throw rechazo('Elegí qué sucursal paga.');
  const referencia = referenciaDe(b.referencia);
  if (referencia && await referenciaRepetida(db, organizationId, referencia, id)) throw rechazo('Ese ID de transferencia ya está cargado.', 409);
  const importeAntes = Number(pago.importe);
  const importeNuevo = b.importe !== undefined ? Math.round(b.importe * 100) / 100 : importeAntes;
  const cambiaImporte = Math.abs(importeNuevo - importeAntes) > 0.004;
  const cambios = [
    cambiaImporte ? `importe ${fmtPesos(importeAntes)} → ${fmtPesos(importeNuevo)}` : null,
    pago.fecha !== b.fecha ? `fecha ${fmtFecha(pago.fecha)} → ${fmtFecha(b.fecha)}` : null,
    pago.medio !== b.medio ? `medio ${pago.medio} → ${b.medio}` : null,
    (pago.referencia ?? null) !== referencia ? `ID ${pago.referencia ?? '—'} → ${referencia ?? '—'}` : null,
    idLugar(pago.business_id, pago.branch_id) !== b.pdvPagaId ? 'quién paga' : null,
  ].filter(Boolean).join(' · ');
  await db.transaction(async (tx) => {
    if (cambiaImporte) {
      await bloquearProveedor(tx, organizationId, pago.codPro);
      const apl = await tx.many(sql`
        SELECT a.id, a.importe::float8 AS importe,
          (SELECT TO_CHAR(MIN(COALESCE(c."fechaManual", c.fecha)), 'YYYY-MM-DD') FROM gestion_compras c
            WHERE c.business_id = a.business_id AND c.branch_id IS NOT DISTINCT FROM a.branch_id AND c.comprobante = a.comprobante AND c.codigo = a."codPro") AS fecha
        FROM gestion_aplicaciones_pago_proveedor a WHERE a."pagoId" = ${id}`);
      const nuevas = recortarAplicaciones(apl.map((a) => ({ id: a.id, fecha: a.fecha ?? '', importe: Number(a.importe) })), importeNuevo);
      for (const n of nuevas) {
        const antes = apl.find((a) => a.id === n.id);
        if (Math.abs(Number(antes.importe) - n.importe) <= 0.004) continue;
        if (n.importe <= 0.004) await tx.execute(sql`DELETE FROM gestion_aplicaciones_pago_proveedor WHERE id = ${n.id}`);
        else await tx.execute(sql`UPDATE gestion_aplicaciones_pago_proveedor SET importe = ${n.importe}::numeric WHERE id = ${n.id}`);
      }
    }
    await tx.execute(sql`
      UPDATE gestion_pagos_proveedor
      SET fecha = ${b.fecha}::date, medio = ${b.medio}, referencia = ${referencia}, branch_id = ${paga.branchId}::bigint, importe = ${importeNuevo}::numeric
      WHERE id = ${id}`);
    if (cambios) await eventoPago(tx, id, 'editado', cambios, null, usuario);
  });
  return { ok: true };
}

// Anular: no se borra, queda en el historial y sus imputaciones se sueltan.
async function anularPago({ organizationId, businessId, usuario, id }) {
  if (!Number.isInteger(id) || id <= 0) throw rechazo('id inválido');
  const pago = await leerPago(db, { organizationId, businessId }, id);
  if (!pago || pago.anuladoEn) throw rechazo('Ese pago ya no existe o está anulado.', 404);
  await db.transaction(async (tx) => {
    await bloquearProveedor(tx, organizationId, pago.codPro);
    await tx.execute(sql`DELETE FROM gestion_aplicaciones_pago_proveedor WHERE "pagoId" = ${id}`);
    await tx.execute(sql`UPDATE gestion_pagos_proveedor SET "anuladoEn" = CURRENT_TIMESTAMP, "anuladoPor" = ${usuario} WHERE id = ${id}`);
    await eventoPago(tx, id, 'anulado', null, Number(pago.importe), usuario);
  });
  return { ok: true };
}

// Quitar el pago de una factura: el importe vuelve a quedar a cuenta.
async function quitarAplicacion({ organizationId, businessId, usuario, id, sp }) {
  const pdvId = Number(sp.get('pdvId'));
  const comprobante = (sp.get('comprobante') ?? '').trim();
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(pdvId) || !comprobante) throw rechazo('Datos inválidos');
  const pago = await leerPago(db, { organizationId, businessId }, id);
  if (!pago || pago.anuladoEn) throw rechazo('Ese pago ya no existe o está anulado.', 404);
  const lugar = (await mapaLugares(db, businessId)).get(pdvId);
  if (!lugar) throw rechazo('Datos inválidos');
  const quitado = await db.transaction(async (tx) => {
    await bloquearProveedor(tx, organizationId, pago.codPro);
    const aps = await tx.many(sql`
      DELETE FROM gestion_aplicaciones_pago_proveedor
      WHERE "pagoId" = ${id} AND business_id = ${businessId} AND branch_id IS NOT DISTINCT FROM ${lugar.branchId}::bigint AND comprobante = ${comprobante}
      RETURNING importe::float8 AS importe`);
    if (!aps.length) return 0;
    const total = aps.reduce((s, a) => s + Number(a.importe), 0);
    await eventoPago(tx, id, 'desimputado', fmtComprobante(comprobante), total, usuario);
    return total;
  });
  return { ok: true, quitado };
}

// ── Cuenta corriente ──────────────────────────────────────────────────
// Facturas del proveedor en este negocio (pagas incluidas), una por lugar + comprobante.
function facturasCtaCteSql({ organizationId, businessId, codPro }) {
  return sql`
    WITH f AS (
      SELECT
        ${lugarSql('c')} AS pdv_id,
        c.comprobante,
        TO_CHAR(MIN(COALESCE(c."fechaManual", c.fecha)), 'YYYY-MM-DD') AS fecha,
        SUM(COALESCE(c."importeManual", c.importe))                   AS total14,
        STRING_AGG(DISTINCT COALESCE(cc.nombre, c.concepto), ' · ')    AS conceptos,
        MIN(c."rowId")                                                 AS row_id
      FROM gestion_compras c
      LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId} AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = cc.codigo
      WHERE c.business_id = ${businessId} AND c.codigo = ${codPro} AND c.comprobante IS NOT NULL
        -- Solo las compras del proveedor del maestro: el mismo código se repite en gastos varios y
        -- empleados (texto, sin proveedorId).
        AND c."proveedorId" IN (SELECT id FROM gestion_proveedores WHERE organization_id = ${organizationId} AND codigo = ${codPro})
      GROUP BY 1, c.comprobante
    ),
    pg AS (
      SELECT
        ${lugarSql('g')} AS pdv_id,
        comprobante,
        TO_CHAR(MIN(fecha), 'YYYY-MM-DD') AS fecha80,
        SUM(importe) AS pagado,
        MAX(total)   AS total80,
        JSON_AGG(JSON_BUILD_OBJECT(
          'fecha', TO_CHAR(COALESCE("fechaPagoManual", "fechaPago"), 'YYYY-MM-DD'), 'importe', importe::float8, 'medio', medio, 'orden', orden
        ) ORDER BY COALESCE("fechaPagoManual", "fechaPago"), secuencia) AS pagos
      FROM gestion_pagos g
      WHERE g.business_id = ${businessId} AND "codPro" = ${codPro} AND comprobante IS NOT NULL
      GROUP BY 1, comprobante
    ),
    lz AS (
      SELECT ${lugarSql('a')} AS pdv_id, a.comprobante,
        JSON_AGG(JSON_BUILD_OBJECT(
          'pagoId', pp.id, 'fecha', TO_CHAR(pp.fecha, 'YYYY-MM-DD'), 'importe', a.importe::float8, 'totalPago', pp.importe::float8,
          'medio', pp.medio, 'referencia', pp.referencia, 'pdvPaga', CONCAT(bp.name, ' · ', COALESCE(sp.name, 'Principal'))
        ) ORDER BY pp.fecha, pp.id) AS pagos_lz
      FROM gestion_aplicaciones_pago_proveedor a
      JOIN gestion_pagos_proveedor pp ON pp.id = a."pagoId" AND pp."anuladoEn" IS NULL
      JOIN app_businesses bp ON bp.id = pp.business_id
      LEFT JOIN app_branches sp ON sp.id = pp.branch_id
      WHERE a.business_id = ${businessId} AND a."codPro" = ${codPro}
      GROUP BY 1, a.comprobante
    )
    SELECT
      COALESCE(f.pdv_id, pg.pdv_id)              AS pdv_id,
      COALESCE(f.comprobante, pg.comprobante)    AS comprobante,
      COALESCE(f.fecha, pg.fecha80)              AS fecha,
      COALESCE(pg.total80, f.total14, 0)::float8 AS total,
      COALESCE(pg.pagado, 0)::float8             AS pagado,
      f.conceptos,
      f.row_id,
      (f.comprobante IS NULL)                    AS "solo80",
      pg.pagos,
      lz.pagos_lz
    FROM f
    FULL OUTER JOIN pg ON pg.comprobante = f.comprobante AND pg.pdv_id = f.pdv_id
    LEFT JOIN lz ON lz.pdv_id = COALESCE(f.pdv_id, pg.pdv_id) AND lz.comprobante = COALESCE(f.comprobante, pg.comprobante)
    ORDER BY 3 DESC NULLS LAST, 2 DESC`;
}

async function obtenerCtaCte({ organizationId, businessId, sp }) {
  const codPro = (sp.get('codPro') ?? '').trim();
  if (!codPro || codPro.length > 40) throw rechazo('Datos inválidos');
  const nombre = (sp.get('nombre') ?? '').trim().slice(0, 120);
  const lugares = await mapaLugares(db, businessId);
  const nombreLugar = (id) => lugares.get(id)?.nombre ?? '';

  // Sin proveedor del maestro (empleado, gastos varios): sus movimientos en ese lugar.
  const pdvId = Number(sp.get('pdvId'));
  if (nombre && lugares.has(pdvId)) {
    const sucursal = lugares.get(pdvId).branchId;
    const [movs, emp] = await Promise.all([
      db.many(sql`
        SELECT c."rowId" AS row_id,
               TO_CHAR(COALESCE(c."fechaManual", c.fecha), 'YYYY-MM-DD') AS fecha,
               c.comprobante,
               COALESCE(cc.nombre, c.concepto) AS concepto,
               rc.nombre AS rubro,
               COALESCE(c."observacManual", c.observac) AS observac,
               COALESCE(c."importeManual", c.importe, 0)::float8 AS importe
        FROM gestion_compras c
        LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId} AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = cc.codigo
        LEFT JOIN gestion_rubros_concepto_caja rc ON rc.organization_id = ${organizationId} AND cc."codRga" = rc.codigo
        WHERE ${enLugar('c', businessId, sucursal)} AND c.codigo = ${codPro} AND c."proveedorId" IS NULL
          AND LOWER(TRIM(c.proveedor)) = LOWER(TRIM(${nombre}))
        ORDER BY 2 DESC, 1
        LIMIT 5000`),
      db.one(sql`
        SELECT NULLIF(TRIM(CONCAT_WS(' ', e.nombre, e.apellido)), '') AS empleado FROM gestion_empleados e
        WHERE ${enLugar('e', businessId, sucursal)} AND e.codigo = ${codPro} AND LOWER(TRIM(e.nombre)) = LOWER(TRIM(${nombre})) LIMIT 1`),
    ]);
    return {
      modo: 'movimientos',
      codPro, pdvId, pdv: nombreLugar(pdvId), nombre,
      proveedor: emp?.empleado ?? nombre,
      esEmpleado: !!emp?.empleado,
      movimientos: movs.map((m) => ({
        rowId: m.row_id, fecha: m.fecha ?? '', comprobante: m.comprobante, concepto: m.concepto?.trim() || '—',
        rubro: m.rubro, observac: m.observac?.trim() || '', importe: Number(m.importe),
      })),
    };
  }

  const [facturas, prov, aCuenta] = await Promise.all([
    db.many(facturasCtaCteSql({ organizationId, businessId, codPro })),
    db.one(sql`
      SELECT COALESCE(p.nombre, (SELECT MAX(c.proveedor) FROM gestion_compras c WHERE c.business_id = ${businessId} AND c.codigo = ${codPro})) AS nombre,
             p.razon, p.cuit, p."pagoAutomatico" AS pago_automatico
      FROM (SELECT 1) x LEFT JOIN gestion_proveedores p ON p.organization_id = ${organizationId} AND p.codigo = ${codPro}`),
    pagosACuenta(db, { organizationId, businessId }, codPro),
  ]);
  const desde = impagasDesde(null, process.env.IMPAGAS_DESDE);
  return {
    modo: 'facturas',
    codPro,
    proveedor: prov?.nombre?.trim() || `Proveedor ${codPro}`,
    razon: prov?.razon ?? null,
    cuit: prov?.cuit ?? null,
    pagoAutomatico: !!prov?.pago_automatico,
    desdeCobertura: desde,
    aCuenta,
    facturas: facturas.map((f) => {
      const total = Number(f.total);
      const p80 = (f.pagos ?? []).map((x) => ({ fecha: x.fecha, importe: Number(x.importe) }));
      const plz = f.pagos_lz ?? [];
      // 80 + Lazarillo (el mismo pago cargado en los dos lados cuenta una vez).
      const comb = combinarPagos(p80, plz.map((x) => ({ fecha: x.fecha, importe: Number(x.importe) })), total);
      return {
        pdvId: Number(f.pdv_id),
        pdv: nombreLugar(Number(f.pdv_id)),
        comprobante: f.comprobante,
        fecha: f.fecha ?? '',
        total, pagado: comb.pagado,
        conceptos: f.conceptos ?? '',
        rowId: f.row_id,
        solo80: f.solo80,
        estado: estadoPago({ comprobante: f.comprobante, fecha: f.fecha, total, pagado: comb.pagado, pagoAutomatico: !!prov?.pago_automatico }, desde),
        pagos: (f.pagos ?? []).map((x) => ({ fecha: x.fecha, importe: Number(x.importe), medio: x.medio, orden: x.orden })),
        pagosLz: plz.map((x, i) => ({ ...x, importe: Number(x.importe), totalPago: Number(x.totalPago), conciliado: comb.conciliados.includes(i) })),
        deMas: comb.deMas,
      };
    }),
  };
}

// Buscador de la cuenta corriente: proveedores con comprobantes en este negocio.
async function buscarProveedoresCtaCte({ organizationId, businessId, sp }) {
  const q = (sp.get('q') ?? '').trim().slice(0, 60);
  const patron = `%${q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const rows = await db.many(sql`
    SELECT c.codigo AS cod_pro, COALESCE(MAX(p.nombre), MAX(c.proveedor)) AS nombre, COUNT(DISTINCT c.comprobante)::int AS facturas
    FROM gestion_compras c
    LEFT JOIN gestion_proveedores p ON p.organization_id = ${organizationId} AND p.codigo = c.codigo
    WHERE c.business_id = ${businessId} AND c.codigo IS NOT NULL AND c.comprobante IS NOT NULL
    GROUP BY c.codigo
    HAVING ${q ? sql`lower(COALESCE(MAX(p.nombre), MAX(c.proveedor), '')) LIKE ${patron} OR c.codigo = ${q}` : sql`TRUE`}
    ORDER BY 3 DESC
    LIMIT 12`);
  return { proveedores: rows.map((r) => ({ codPro: r.cod_pro, nombre: r.nombre?.trim() || `Proveedor ${r.cod_pro}`, facturas: Number(r.facturas) })) };
}

module.exports = {
  obtenerSinCarga, crearDescarte, borrarDescarte,
  obtenerImpagas, crearForzadas, borrarForzadas, cambiarPagoAutomatico, obtenerOpMaxirest,
  crearOp, editarOp, obtenerOp, anularOp, desimputarOp, historialOp,
  registrarPago, editarPago, anularPago, quitarAplicacion,
  obtenerCtaCte, buscarProveedoresCtaCte,
};
