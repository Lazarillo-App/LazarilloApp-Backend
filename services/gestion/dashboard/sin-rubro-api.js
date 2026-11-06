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
      SELECT c."rowId", c.branch_id, c.comprobante, c.codigo, c.proveedor
        FROM gestion_compras c
       WHERE ${filtroSucursalSql('c', businessId, sucursal)}
         AND c.origen = ${ORIGEN_SIN_CONCEPTO}
         AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") IS NULL
         AND ${fechaEco} >= ${desde}::timestamp AND ${fechaEco} < ${hasta}::timestamp
    )
    SELECT CASE WHEN l.m_cod IS NULL THEN 'sin-insumo' WHEN l.m_rubro IS NULL THEN 'insumo' ELSE 'rubro' END AS tipo,
           COALESCE(l.m_rubro, '') AS rubro, TRIM(COALESCE(l.nombre, '')) AS insumo,
           l.rubro_codigo::text AS rubro_codigo, l.insumo_id::int AS insumo_id,
           l.iva::float8 AS iva, l.imp_int::float8 AS imp_int,
           c."rowId" AS row_id, c.comprobante, c.proveedor, l.importe::float8 AS importe
      FROM l JOIN c ON c.branch_id IS NOT DISTINCT FROM l.branch_id AND c.comprobante = l.comprobante
                   AND c.codigo IS NOT DISTINCT FROM l."codPro"
     WHERE l.cres IS NULL`);

  // Otras compras en Sin rubro: su concepto no tiene rubro o no está en el Panel.
  const otras = await db.many(sql`
    SELECT COALESCE(NULLIF(TRIM(COALESCE(cc.nombre, c.concepto)), ''), 'Sin concepto') AS concepto,
           cc.codigo AS concepto_codigo,
           c."rowId" AS row_id, c.comprobante, c.proveedor, COALESCE(c."importeManual", c.importe)::float8 AS importe
      FROM gestion_compras c
      LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId}
            AND cc.codigo = COALESCE(c."conceptoCodigoManual", c."conceptoCodigo")
      LEFT JOIN gestion_rubros_concepto_caja rc ON rc.organization_id = ${organizationId} AND rc.codigo = cc."codRga"
     WHERE ${filtroSucursalSql('c', businessId, sucursal)}
       AND c.origen IS DISTINCT FROM ${ORIGEN_SIN_CONCEPTO}
       AND rc.codigo IS NULL
       AND ${fechaEco} >= ${desde}::timestamp AND ${fechaEco} < ${hasta}::timestamp`);

  const r2 = (n) => Math.round(n * 100) / 100;
  // editarDe(f): qué se corrige desde el panel (null si no se puede desde Lazarillo).
  const grupo = (tipo, titulo, accion, filas, claveDe, detalleDe, editarDe = () => null) => {
    const items = new Map();
    for (const f of filas) {
      const k = claveDe(f);
      const it = items.get(k) ?? { nombre: k, importe: 0, nombres: new Map(), cpb: new Map(), editar: editarDe(f) };
      it.importe += f.importe;
      const n = detalleDe(f);
      if (n) it.nombres.set(n, (it.nombres.get(n) ?? 0) + Math.abs(f.importe));
      const cp = it.cpb.get(f.row_id) ?? { rowId: f.row_id, comprobante: f.comprobante, proveedor: f.proveedor, importe: 0 };
      cp.importe += f.importe;
      it.cpb.set(f.row_id, cp);
      items.set(k, it);
    }
    const lista = [...items.values()].map((it) => ({
      nombre: it.nombre,
      importe: r2(it.importe),
      detalle: [...it.nombres.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n),
      comprobantes: [...it.cpb.values()].map((c) => ({ ...c, importe: r2(c.importe) })).sort((a, b) => Math.abs(b.importe) - Math.abs(a.importe)).slice(0, MAX_CPB),
      cantidadComprobantes: it.cpb.size,
      editar: it.editar,
    })).filter((it) => Math.abs(it.importe) >= 0.01).sort((a, b) => Math.abs(b.importe) - Math.abs(a.importe));
    return { tipo, titulo, accion, importe: r2(lista.reduce((s, i) => s + i.importe, 0)), items: lista };
  };

  const grupos = [
    grupo('rubro', 'Rubro de insumo sin concepto de caja', 'Se corrige una vez por rubro en MaxiRest (rubro → concepto de caja) y arregla todos sus insumos, también lo ya cargado.',
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

/** Rubro de insumo → concepto de caja (corregido en Lazarillo: la sincronización con MaxiRest no lo pisa). */
async function editarRubroInsumo({ organizationId, codigo, body }) {
  const cod = String(codigo ?? '').trim();
  if (!/^\d+$/.test(cod) || cod === '0') throw rechazo('Rubro inválido');
  const concepto = await conceptoDeLaOrg(organizationId, body?.concepto);
  const n = await db.execute(sql`
    UPDATE insumo_rubros SET cpto_caja_lazarillo = ${Number(concepto)}
     WHERE codigo_maxi::text = ${cod}
       AND business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId})`);
  if (!n) throw rechazo('No existe ese rubro de insumo', 404);
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
     WHERE "rowId" = ${String(rowId ?? '')} AND origen = ${ORIGEN_SIN_CONCEPTO}
       AND business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId})`);
  if (!n) throw rechazo('No existe esa compra', 404);
  return { ok: true };
}

module.exports = { obtenerSinRubro, editarRubroInsumo, editarInsumo, editarCompraSinConcepto };
