// "Sin rubro · por qué" (Diego 06/11/2026): lo que cae en Sin rubro del tablero, agrupado por la
// causa y con lo que hay que hacer para corregirlo, así se resuelve de raíz en MaxiRest:
// 1) rubro de insumo sin concepto de caja → se corrige una vez por rubro (arregla todos sus insumos);
// 2) insumo sin rubro → se le asigna rubro;
// 3) renglón sin insumo del maestro;
// 4) concepto de caja sin rubro (o que no está en el Panel).
// Lo "ya corregido en MaxiRest" no aparece: render/sin-concepto.js lo pasa solo a su concepto.
'use strict';

const { sql, db } = require('../db');
const { filtroSucursalSql } = require('./query-builders');
const { renglonesSql, esquemaDe, ORIGEN_SIN_CONCEPTO, resincronizarOrganizacion } = require('../render/sin-concepto');
const { ORIGEN_LAZARILLO } = require('../facturas/armar');
const { ErrorDatos } = require('./resultados-api');

const rechazo = (mensaje, status = 400) => { const e = new ErrorDatos(mensaje); e.status = status; return e; };

const MAX_CPB = 40;

async function obtenerSinRubro({ organizationId, businessId, sucursal, anio }) {
  const year = Number.isInteger(anio) ? anio : new Date().getFullYear();
  const desde = `${year}-01-01`;
  const hasta = `${year + 1}-01-01`;
  const fechaEco = sql`COALESCE(c."fechaManual", c.periodo, c.fecha)`;
  const esquema = await esquemaDe(db, businessId);
  const sucDc = sucursal === undefined ? sql`true`
    : sucursal === null ? sql`dc.branch_id IS NULL` : sql`dc.branch_id = ${sucursal}`;

  // Renglones de las compras sin concepto que siguen sin concepto (las del año que se mira).
  const renglones = await db.many(sql`
    WITH l AS (${renglonesSql({ businessId, esquema, sucursalCond: sucDc })}),
    c AS (
      SELECT c."rowId", c.branch_id, c.comprobante, c.codigo, c.proveedor, c.fecha
        FROM gestion_compras c
       WHERE ${filtroSucursalSql('c', businessId, sucursal)}
         AND c.origen = ${ORIGEN_SIN_CONCEPTO}
         AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") IS NULL
         AND ${fechaEco} >= ${desde}::timestamp AND ${fechaEco} < ${hasta}::timestamp
    )
    SELECT CASE WHEN l.alternativas IS NOT NULL THEN 'por-compra' WHEN l.m_cod IS NULL THEN 'sin-insumo' WHEN l.m_rubro IS NULL THEN 'insumo' ELSE 'rubro' END AS tipo,
           COALESCE(l.m_rubro, '') AS rubro, TRIM(COALESCE(l.nombre, '')) AS insumo,
           l.rubro_codigo::text AS rubro_codigo, l.insumo_id::int AS insumo_id, l.alternativas,
           l.iva::float8 AS iva, l.imp_int::float8 AS imp_int,
           c."rowId" AS row_id, c.comprobante, c.proveedor, to_char(c.fecha, 'YYYY-MM-DD') AS fecha, l.importe::float8 AS importe
      -- Cada renglón con SU fila: misma clave que arma render/sin-concepto (las de «se decide en cada
      -- compra» van aparte por rubro, así cada una se resuelve por su lado).
      FROM l JOIN c ON c."rowId" = 'sc:' || md5(l.business_id::text || '|' || COALESCE(l.branch_id::text, '') || '|' || l.comprobante
                                              || '|' || COALESCE(l."codPro", '') || COALESCE('|r' || l.grupo, ''))
     WHERE l.cres IS NULL`);

  // Facturas cargadas en Lazarillo con renglones sin concepto (Diego 07/11/2026: data entry puede dejarlos
  // para el administrador). Mismo formato que los de MaxiRest.
  const deLazarillo = await db.many(sql`
    SELECT CASE WHEN al.alts IS NOT NULL THEN 'por-compra' WHEN li.id IS NULL THEN 'sin-insumo' WHEN lr.nombre IS NULL THEN 'insumo' ELSE 'rubro' END AS tipo,
           COALESCE(TRIM(lr.nombre), '') AS rubro, TRIM(COALESCE(dl.nombre, '')) AS insumo,
           lr.codigo_maxi::text AS rubro_codigo, li.id::int AS insumo_id, al.alts AS alternativas,
           COALESCE(dl."ivaTot", 0)::float8 AS iva, COALESCE(dl."impNtTot", 0)::float8 AS imp_int,
           c."rowId" AS row_id, c.comprobante, c.proveedor, to_char(c.fecha, 'YYYY-MM-DD') AS fecha,
           (SIGN(c.importe) * (COALESCE(dl."totalIns", 0) + COALESCE(dl."ivaTot", 0) + COALESCE(dl."impNtTot", 0)))::float8 AS importe
      FROM gestion_compras c
      JOIN gestion_detalle_compras dl ON dl.business_id = c.business_id AND dl."compraId" = c."rowId" AND dl.origen = ${ORIGEN_LAZARILLO}
      LEFT JOIN LATERAL (
        SELECT i.id, i.business_id, i.rubro FROM insumos i
         WHERE i.business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId})
           AND regexp_replace(TRIM(i.codigo_maxi::text), '\\.0+$', '') = regexp_replace(TRIM(dl.codigo::text), '\\.0+$', '')
         ORDER BY (i.business_id = ${businessId}) DESC, i.activo DESC NULLS LAST, i.id LIMIT 1) li ON true
      LEFT JOIN LATERAL (
        SELECT r.codigo_maxi, r.nombre FROM insumo_rubros r
         WHERE r.business_id = li.business_id AND NULLIF(TRIM(li.rubro), '0') IS NOT NULL AND r.codigo_maxi::text = TRIM(li.rubro)
         ORDER BY r.id LIMIT 1) lr ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('etiqueta', a.etiqueta, 'concepto', a.concepto) ORDER BY a.orden, a.id) AS alts
          FROM insumo_rubro_conceptos a
         WHERE lr.codigo_maxi IS NOT NULL AND a.organization_id = ${organizationId} AND a.rubro_codigo = lr.codigo_maxi::text) al ON true
     WHERE ${filtroSucursalSql('c', businessId, sucursal)}
       AND c.origen = ${ORIGEN_LAZARILLO}
       AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") IS NULL
       AND ${fechaEco} >= ${desde}::timestamp AND ${fechaEco} < ${hasta}::timestamp`);
  renglones.push(...deLazarillo);

  // Otras compras en Sin rubro: su concepto no tiene rubro o no está en el Panel.
  const otras = await db.many(sql`
    SELECT COALESCE(NULLIF(TRIM(COALESCE(cc.nombre, c.concepto)), ''), 'Sin concepto') AS concepto,
           cc.codigo AS concepto_codigo,
           c."rowId" AS row_id, c.comprobante, c.proveedor, to_char(c.fecha, 'YYYY-MM-DD') AS fecha, COALESCE(c."importeManual", c.importe)::float8 AS importe
      FROM gestion_compras c
      LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId}
            AND cc.codigo = COALESCE(c."conceptoCodigoManual", c."conceptoCodigo")
      LEFT JOIN gestion_rubros_concepto_caja rc ON rc.organization_id = ${organizationId} AND rc.codigo = cc."codRga"
     WHERE ${filtroSucursalSql('c', businessId, sucursal)}
       AND c.origen IS DISTINCT FROM ${ORIGEN_SIN_CONCEPTO}
       AND NOT (c.origen = ${ORIGEN_LAZARILLO} AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") IS NULL)
       AND rc.codigo IS NULL
       AND ${fechaEco} >= ${desde}::timestamp AND ${fechaEco} < ${hasta}::timestamp`);

  const r2 = (n) => Math.round(n * 100) / 100;
  // editarDe(f): qué se corrige desde el panel (null si no se puede desde Lazarillo).
  const grupo = (tipo, titulo, accion, filas, claveDe, detalleDe, editarDe = () => null) => {
    const items = new Map();
    for (const f of filas) {
      const k = claveDe(f);
      const it = items.get(k) ?? { nombre: k, importe: 0, nombres: new Map(), cpb: new Map(), editar: editarDe(f), opciones: f.alternativas ?? null };
      it.importe += f.importe;
      const n = detalleDe(f);
      if (n) it.nombres.set(n, (it.nombres.get(n) ?? 0) + Math.abs(f.importe));
      const cp = it.cpb.get(f.row_id) ?? { rowId: f.row_id, comprobante: f.comprobante, proveedor: f.proveedor, fecha: f.fecha ?? null, importe: 0, insumos: new Set() };
      cp.importe += f.importe;
      if (f.insumo) cp.insumos.add(f.insumo);
      it.cpb.set(f.row_id, cp);
      items.set(k, it);
    }
    const lista = [...items.values()].map((it) => ({
      nombre: it.nombre,
      importe: r2(it.importe),
      detalle: [...it.nombres.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n),
      comprobantes: [...it.cpb.values()].map((c) => ({ ...c, importe: r2(c.importe), insumos: [...c.insumos] })).sort((a, b) => Math.abs(b.importe) - Math.abs(a.importe)).slice(0, MAX_CPB),
      cantidadComprobantes: it.cpb.size,
      editar: it.editar,
      ...(it.opciones ? { opciones: it.opciones } : {}),
    })).filter((it) => Math.abs(it.importe) >= 0.01).sort((a, b) => Math.abs(b.importe) - Math.abs(a.importe));
    return { tipo, titulo, accion, importe: r2(lista.reduce((s, i) => s + i.importe, 0)), items: lista };
  };

  const grupos = [
    grupo('por-compra', 'Se decide en cada compra', 'Rubros con más de un concepto posible: elegí el de cada compra.',
      renglones.filter((f) => f.tipo === 'por-compra'), (f) => f.rubro, (f) => f.insumo,
      (f) => ({ tipo: 'rubro-insumo', codigo: f.rubro_codigo, alternativas: f.alternativas })),
    grupo('rubro', 'Rubro de insumo sin concepto de caja', 'Elegile el concepto (o varios, si depende de la compra): arregla todos sus insumos, también lo ya cargado.',
      renglones.filter((f) => f.tipo === 'rubro'), (f) => f.rubro, (f) => f.insumo,
      (f) => (f.rubro_codigo ? { tipo: 'rubro-insumo', codigo: f.rubro_codigo } : null)),
    grupo('insumo', 'Insumo sin rubro', 'Asignale rubro al insumo (como en Insumos).',
      renglones.filter((f) => f.tipo === 'insumo'), (f) => f.insumo || 'Sin nombre', () => null,
      (f) => (f.insumo_id ? { tipo: 'insumo', id: f.insumo_id } : null)),
    grupo('sin-insumo', 'Renglón sin insumo', 'El renglón no es un insumo: asignale concepto a la compra (o corregí la factura en MaxiRest).',
      renglones.filter((f) => f.tipo === 'sin-insumo'), (f) => `${f.insumo || 'Renglón sin nombre'}${f.proveedor ? ` · ${f.proveedor}` : ''}${pistaRenglon(f)}`, () => null,
      (f) => ({ tipo: 'compra', rowId: f.row_id })),
    grupo('concepto', 'Concepto de caja sin rubro', 'Asignale rubro al concepto de caja (como en Conceptos).',
      otras, (f) => f.concepto, (f) => f.proveedor,
      (f) => (f.concepto_codigo != null ? { tipo: 'concepto', codigo: Number(f.concepto_codigo) } : null)),
  ].filter((g) => g.items.length);

  // Rubros de insumo para elegir (son de la organización: viven en el negocio principal).
  const rubrosInsumo = await db.many(sql`
    SELECT DISTINCT ON (r.codigo_maxi) r.codigo_maxi::text AS codigo, TRIM(r.nombre) AS nombre
      FROM insumo_rubros r
     WHERE r.business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId})
       AND NULLIF(TRIM(r.codigo_maxi::text), '0') IS NOT NULL AND NULLIF(TRIM(r.nombre), '') IS NOT NULL
     ORDER BY r.codigo_maxi, (r.business_id = ${businessId}) DESC, r.id`);

  return {
    anio: year, importe: r2(grupos.reduce((s, g) => s + g.importe, 0)), grupos,
    rubrosInsumo: rubrosInsumo.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
  };
}

// Pista para el renglón sin insumo y sin IVA: suele ser una percepción cargada como renglón.
function pistaRenglon(f) {
  if (f.insumo || Math.abs(f.iva ?? 0) >= 0.01) return '';
  return ' · sin IVA: ¿percepción?';
}

const conceptoDeLaOrg = async (organizationId, crudo) => {
  const n = Number(crudo);
  if (!Number.isInteger(n) || n <= 0) throw rechazo('Elegí un concepto de caja');
  const c = await db.one(sql`SELECT codigo FROM gestion_conceptos_caja WHERE organization_id = ${organizationId} AND codigo = ${String(n)}`);
  if (!c) throw rechazo('Ese concepto no está en el Panel', 404);
  return String(n);
};

/**
 * Rubro de insumo → concepto de caja (corregido en Lazarillo: la sincronización con MaxiRest no lo pisa).
 * body { concepto } = siempre el mismo · body { alternativas: [{ etiqueta, concepto }, …] } (2 o más) =
 * depende de la compra: al cargar se pregunta y lo ya cargado queda «se decide en cada compra».
 */
async function editarRubroInsumo({ organizationId, codigo, body }) {
  const cod = String(codigo ?? '').trim();
  if (!/^\d+$/.test(cod) || cod === '0') throw rechazo('Rubro inválido');
  const enOrg = sql`business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId})`;
  const existe = await db.one(sql`SELECT 1 AS ok FROM insumo_rubros WHERE codigo_maxi::text = ${cod} AND ${enOrg} LIMIT 1`);
  if (!existe) throw rechazo('No existe ese rubro de insumo', 404);
  if (Array.isArray(body?.alternativas)) {
    const alts = [];
    for (const a of body.alternativas) {
      const etiqueta = String(a?.etiqueta ?? '').trim().slice(0, 40);
      if (!etiqueta) throw rechazo('Cada opción necesita un nombre (ej. Reposición)');
      if (alts.some((x) => x.etiqueta.toLowerCase() === etiqueta.toLowerCase())) throw rechazo('Hay dos opciones con el mismo nombre');
      alts.push({ etiqueta, concepto: await conceptoDeLaOrg(organizationId, a?.concepto) });
    }
    if (alts.length < 2) throw rechazo('Poné al menos dos opciones');
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM insumo_rubro_conceptos WHERE organization_id = ${organizationId} AND rubro_codigo = ${cod}`);
      for (const [i, a] of alts.entries()) {
        await tx.execute(sql`
          INSERT INTO insumo_rubro_conceptos (organization_id, rubro_codigo, etiqueta, concepto, orden)
          VALUES (${organizationId}, ${cod}, ${a.etiqueta}, ${a.concepto}, ${i})`);
      }
      await tx.execute(sql`UPDATE insumo_rubros SET cpto_caja_lazarillo = NULL WHERE codigo_maxi::text = ${cod} AND ${enOrg}`);
    });
  } else {
    const concepto = await conceptoDeLaOrg(organizationId, body?.concepto);
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM insumo_rubro_conceptos WHERE organization_id = ${organizationId} AND rubro_codigo = ${cod}`);
      await tx.execute(sql`UPDATE insumo_rubros SET cpto_caja_lazarillo = ${Number(concepto)} WHERE codigo_maxi::text = ${cod} AND ${enOrg}`);
      // Facturas de Lazarillo que quedaron sin concepto con renglones SOLO de este rubro: pasan al concepto.
      await tx.execute(sql`
        UPDATE gestion_compras c SET "conceptoCodigoManual" = ${concepto}
         WHERE c.${enOrg} AND c.origen = ${ORIGEN_LAZARILLO}
           AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") IS NULL
           AND EXISTS (SELECT 1 FROM gestion_detalle_compras d WHERE d.business_id = c.business_id AND d."compraId" = c."rowId")
           AND NOT EXISTS (
             SELECT 1 FROM gestion_detalle_compras d
              WHERE d.business_id = c.business_id AND d."compraId" = c."rowId"
                AND NOT EXISTS (
                  SELECT 1 FROM insumos i
                   WHERE i.${enOrg} AND TRIM(i.rubro) = ${cod}
                     AND regexp_replace(TRIM(i.codigo_maxi::text), '\\.0+$', '') = regexp_replace(TRIM(d.codigo::text), '\\.0+$', '')))`);
    });
  }
  await resincronizarOrganizacion(organizationId);
  return { ok: true };
}

/** Insumo → rubro (lo mismo que cambiarlo en Insumos: se guarda el código del rubro). */
async function editarInsumo({ organizationId, id, body }) {
  if (!Number.isInteger(id) || id <= 0) throw rechazo('Insumo inválido');
  const rubro = String(body?.rubro ?? '').trim();
  if (!/^\d+$/.test(rubro) || rubro === '0') throw rechazo('Elegí un rubro');
  const ins = await db.one(sql`
    SELECT i.business_id FROM insumos i
     WHERE i.id = ${id} AND i.business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId})`);
  if (!ins) throw rechazo('No existe ese insumo', 404);
  const r = await db.one(sql`
    SELECT 1 AS ok FROM insumo_rubros WHERE business_id = ${ins.business_id} AND codigo_maxi::text = ${rubro}`);
  if (!r) throw rechazo('Ese rubro no existe', 404);
  await db.execute(sql`UPDATE insumos SET rubro = ${rubro}, updated_at = NOW() WHERE id = ${id}`);
  await resincronizarOrganizacion(organizationId);
  return { ok: true };
}

/** Compra sin concepto → concepto elegido a mano (la sincronización conserva lo manual). */
async function editarCompraSinConcepto({ organizationId, rowId, body }) {
  const concepto = await conceptoDeLaOrg(organizationId, body?.concepto);
  const n = await db.execute(sql`
    UPDATE gestion_compras SET "conceptoCodigoManual" = ${concepto}
     WHERE "rowId" = ${String(rowId ?? '')}
       AND (origen = ${ORIGEN_SIN_CONCEPTO}
            OR (origen = ${ORIGEN_LAZARILLO} AND COALESCE("conceptoCodigoManual", "conceptoCodigo") IS NULL))
       AND business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId})`);
  if (!n) throw rechazo('No existe esa compra', 404);
  return { ok: true };
}

module.exports = { obtenerSinRubro, editarRubroInsumo, editarInsumo, editarCompraSinConcepto };
