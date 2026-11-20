// services/servicioCosto.js
// Recetas de tipo SERVICIO (Diego 20/11/2026, canchas de Container FC; pensado genérico: horas de cancha,
// noches de hotel, horas de salón, un garage). Un servicio no tiene insumos: su costo sale de los costos
// estructurales del local y de cuánto se usa.
//
// recetas.servicio (JSONB):
//   ancla    { tipo: 'ancla', sucursal: null | branchId, reparto: 'ventas' | 'manual',
//              pct: { alquiler, sueldos, servicios, mercaderias }  (0-100; solo con reparto 'manual'),
//              propios: [codigoConcepto] }  conceptos que son 100 % del servicio (Beelup, césped…)
//   derivado { tipo: 'derivado', ancla: articleId, factor: number }  (0,93 = 93 % de la hora de la ancla;
//              3,7 = un cumple que vale 3,7 horas)
//
// Ancla:
//   costo del mes   = Σ rubros de Tu canasta del local (alquiler, sueldos, servicios y, si se elige,
//                     mercaderías) × la parte que le toca al servicio + los conceptos propios al 100 %.
//                     Promedio de los últimos 3 meses cerrados (al día, sin el ruido de un mes suelto).
//   parte por ventas = lo que facturan la ancla y sus derivados ÷ lo que factura el local (12 meses).
//   horas del mes   = promedio de 12 meses de (facturación de la familia ÷ precio de la ancla ese mes)
//                     (Diego 20/11: anual, no trimestral, para que sea estable). Cada mes con su precio:
//                     la inflación no infla las horas.
//   costo por hora  = costo del mes ÷ horas.  Cada servicio cuesta costo por hora × su factor.
//
// Las integraciones solo leen ventas del POS (sales_daily_items): nada está atado a MaxiRest.
'use strict';
const pool = require('../config/db');

const RUBROS = [
  { clave: 'alquiler', nombre: 'Alquiler', codRga: '21', defecto: true },
  { clave: 'sueldos', nombre: 'Sueldos', codRga: '3', defecto: true },
  { clave: 'servicios', nombre: 'Servicios', codRga: '2', defecto: true },
  { clave: 'mercaderias', nombre: 'Mercaderías', codRga: '1', defecto: false },
];
const MESES_HORAS = 12;
const MESES_COSTO = 3;

/** "YYYY-MM" de los n meses cerrados anteriores al mes de `hoy` (el último es el mes pasado). */
function mesesCerrados(n, hoy = new Date()) {
  const out = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
const finDe = (m) => { const [a, mm] = m.split('-').map(Number); return new Date(Date.UTC(a, mm, 1)).toISOString().slice(0, 10); };

/** Normaliza lo que manda el front. Devuelve null si no es un servicio válido. */
function normalizarConfig(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.tipo === 'ancla') {
    const pct = {};
    for (const r of RUBROS) {
      const v = Number(c.pct?.[r.clave]);
      if (Number.isFinite(v)) pct[r.clave] = Math.max(0, Math.min(100, v));
    }
    const incluir = {};
    for (const r of RUBROS) incluir[r.clave] = c.incluir?.[r.clave] == null ? r.defecto : !!c.incluir[r.clave];
    return {
      tipo: 'ancla',
      sucursal: c.sucursal == null || c.sucursal === '' ? null : Number(c.sucursal),
      reparto: c.reparto === 'manual' ? 'manual' : 'ventas',
      pct, incluir,
      propios: [...new Set((Array.isArray(c.propios) ? c.propios : []).map(String).filter(Boolean))],
    };
  }
  if (c.tipo === 'derivado') {
    const ancla = Number(c.ancla);
    const factor = Number(c.factor);
    if (!Number.isFinite(ancla) || ancla === 0 || !(factor > 0)) return null;
    return { tipo: 'derivado', ancla, factor };
  }
  return null;
}

async function recetaDe(db, businessId, articleId) {
  const { rows } = await db.query(
    `SELECT id, article_id, nombre, servicio, porciones FROM recetas
      WHERE business_id = $1 AND article_id = $2 AND active = TRUE
      ORDER BY es_promo ASC, id DESC LIMIT 1`, [businessId, articleId]);
  return rows[0] || null;
}

/**
 * Calcula una ancla con su familia. No escribe nada.
 * @returns detalle para el modal: costos por rubro, horas por mes, costo por hora y familia.
 */
async function calcularAncla(businessId, anclaArticleId, { db = pool, configOverride = null, hoy = new Date() } = {}) {
  const rec = await recetaDe(db, businessId, anclaArticleId);
  const cfg = normalizarConfig(configOverride || rec?.servicio);
  if (!cfg || cfg.tipo !== 'ancla') return null;

  const { rows: bizRows } = await db.query(`SELECT organization_id FROM app_businesses WHERE id = $1`, [businessId]);
  const orgId = Number(bizRows[0]?.organization_id) || null;

  // Familia: la ancla (factor 1) + los derivados del negocio que la eligieron.
  const { rows: der } = await db.query(
    `SELECT r.article_id, r.nombre, (r.servicio->>'factor')::float8 AS factor
       FROM recetas r
      WHERE r.business_id = $1 AND r.active = TRUE AND r.servicio->>'tipo' = 'derivado'
        AND (r.servicio->>'ancla')::bigint = $2
      ORDER BY r.nombre`, [businessId, anclaArticleId]);
  const familia = [{ articleId: Number(anclaArticleId), nombre: rec?.nombre || null, factor: 1, ancla: true },
    ...der.map((d) => ({ articleId: Number(d.article_id), nombre: d.nombre, factor: Number(d.factor) || 0, ancla: false }))];
  const ids = familia.map((f) => f.articleId);

  const suc = cfg.sucursal;
  const lugarVentas = suc == null ? 'branch_id IS NULL' : 'branch_id = $4';

  // ── Ventas de 12 meses: total del local, de la familia y precio de la ancla por mes ──
  const mesesH = mesesCerrados(MESES_HORAS, hoy);
  const desdeH = `${mesesH[0]}-01`, hastaH = finDe(mesesH[mesesH.length - 1]);
  const paramsV = [businessId, desdeH, hastaH];
  if (suc != null) paramsV.push(suc);
  paramsV.push(ids, anclaArticleId);
  const pIds = suc != null ? '$5' : '$4', pAncla = suc != null ? '$6' : '$5';
  const { rows: ventas } = await db.query(
    `SELECT to_char(day, 'YYYY-MM') AS m,
            SUM(amount)::float8 AS total,
            (SUM(amount) FILTER (WHERE article_id = ANY(${pIds}::int[])))::float8 AS familia,
            (SUM(amount) FILTER (WHERE article_id = ${pAncla}))::float8 AS ancla_monto,
            (SUM(qty) FILTER (WHERE article_id = ${pAncla}))::float8 AS ancla_qty
       FROM sales_daily_items
      WHERE business_id = $1 AND ${lugarVentas} AND day >= $2::date AND day < $3::date
      GROUP BY 1`, paramsV);
  const vMap = new Map(ventas.map((v) => [v.m, v]));
  const meses = mesesH.map((m) => {
    const v = vMap.get(m);
    const precio = v && v.ancla_qty > 0 ? v.ancla_monto / v.ancla_qty : null;
    const fam = v?.familia || 0;
    return { mes: m, ventasLocal: v?.total || 0, ventasServicio: fam, precioAncla: precio, horas: precio ? fam / precio : null };
  });
  const conHoras = meses.filter((x) => x.horas != null);
  const horas = conHoras.length ? conHoras.reduce((a, x) => a + x.horas, 0) / conHoras.length : 0;
  const ultimos3 = conHoras.slice(-3);
  const horas3 = ultimos3.length ? ultimos3.reduce((a, x) => a + x.horas, 0) / ultimos3.length : null;
  const totLocal = meses.reduce((a, x) => a + x.ventasLocal, 0);
  const totServ = meses.reduce((a, x) => a + x.ventasServicio, 0);
  const parteVentas = totLocal > 0 ? totServ / totLocal : 0;

  // ── Costos de los últimos 3 meses cerrados, por rubro y concepto (con aperturas) ──
  const mesesC = mesesCerrados(MESES_COSTO, hoy);
  const desdeC = `${mesesC[0]}-01`, hastaC = finDe(mesesC[mesesC.length - 1]);
  const paramsC = [businessId, desdeC, hastaC, orgId];
  if (suc != null) paramsC.push(suc);
  const lugarC = suc == null ? 'v.branch_id IS NULL' : 'v.branch_id = $5';
  const { rows: costos } = orgId ? await db.query(
    `SELECT cc."codRga" AS r, cc.codigo, cc.nombre,
            SUM(COALESCE(v."importeManual", v.importe))::float8 AS total,
            COUNT(DISTINCT to_char(date_trunc('month', COALESCE(v."fechaManual", v.periodo, v.fecha)), 'YYYY-MM'))::int AS meses
       FROM gestion_v_compras_distribuidas v
       JOIN gestion_conceptos_caja cc ON cc.organization_id = $4
                                     AND cc.codigo = COALESCE(v."conceptoCodigoManual", v."conceptoCodigo")
      WHERE v.business_id = $1 AND ${lugarC}
        AND COALESCE(v."fechaManual", v.periodo, v.fecha) >= $2::timestamp
        AND COALESCE(v."fechaManual", v.periodo, v.fecha) < $3::timestamp
        AND cc."codRga" IN ('1', '2', '3', '21')
      GROUP BY 1, 2, 3`, paramsC) : { rows: [] };

  const propiosSet = new Set(cfg.propios);
  const rubros = RUBROS.map((r) => {
    const filas = costos.filter((c) => c.r === r.codRga);
    const mensual = filas.reduce((a, c) => a + c.total, 0) / MESES_COSTO;
    const propios = filas.filter((c) => propiosSet.has(String(c.codigo)))
      .map((c) => ({ codigo: c.codigo, nombre: c.nombre, mensual: c.total / MESES_COSTO }));
    const mensualPropios = propios.reduce((a, c) => a + c.mensual, 0);
    const incluido = !!cfg.incluir[r.clave];
    const pct = !incluido ? 0 : cfg.reparto === 'manual' ? (cfg.pct[r.clave] ?? 0) : parteVentas * 100;
    const asignado = incluido ? (mensual - mensualPropios) * pct / 100 + mensualPropios : 0;
    return { clave: r.clave, nombre: r.nombre, mensual, pct, incluido, propios, asignado };
  });
  const costoMes = rubros.reduce((a, r) => a + r.asignado, 0);
  const costoHora = horas > 0 ? costoMes / horas : 0;

  const conceptos = costos.filter((c) => ['2', '3', '21'].includes(c.r))
    .map((c) => ({ codigo: c.codigo, nombre: c.nombre, rubro: RUBROS.find((r) => r.codRga === c.r)?.clave, mensual: c.total / MESES_COSTO }))
    .sort((a, b) => b.mensual - a.mensual);

  return {
    articleId: Number(anclaArticleId), recetaId: rec?.id ?? null, config: cfg,
    meses, mesesConDatos: conHoras.length, horas, horasUltimos3: horas3, parteVentas,
    mesesCosto: mesesC, rubros, conceptos, costoMes, costoHora,
    familia: familia.map((f) => ({ ...f, costo: costoHora * f.factor })),
    sinDatos: conHoras.length === 0 || costoMes === 0,
  };
}

/** Escribe el costo de la ancla y de toda su familia en recetas (lo que lee la tabla de artículos). */
async function aplicarCostosFamilia(businessId, calculo, db = pool) {
  if (!calculo) return [];
  const cambiados = [];
  for (const f of calculo.familia) {
    const costo = Number((f.costo || 0).toFixed(4));
    const { rows } = await db.query(
      `UPDATE recetas SET costo_total = $3, costo_unitario = $3 / NULLIF(porciones, 0), costo_total_con_merma = $3, updated_at = NOW()
        WHERE business_id = $1 AND article_id = $2 AND active = TRUE AND servicio IS NOT NULL
          AND costo_total IS DISTINCT FROM $3
        RETURNING id, article_id`, [businessId, f.articleId, costo]);
    if (rows.length) cambiados.push(Number(f.articleId));
  }
  return cambiados;
}

/** Recalcula la familia de un servicio (sea ancla o derivado). Devuelve el cálculo de la ancla. */
async function recalcularServicio(businessId, articleId, db = pool) {
  const rec = await recetaDe(db, businessId, articleId);
  const cfg = normalizarConfig(rec?.servicio);
  if (!cfg) return null;
  const anclaId = cfg.tipo === 'ancla' ? Number(articleId) : cfg.ancla;
  const calc = await calcularAncla(businessId, anclaId, { db });
  if (calc) calc.cambiados = await aplicarCostosFamilia(businessId, calc, db);
  return calc;
}

/** Anclas del negocio, para el desplegable del servicio derivado. */
async function listarAnclas(businessId, db = pool) {
  const { rows } = await db.query(
    `SELECT article_id, nombre, costo_total::float8 AS costo_hora, servicio->>'sucursal' AS sucursal
       FROM recetas WHERE business_id = $1 AND active = TRUE AND servicio->>'tipo' = 'ancla'
      ORDER BY nombre`, [businessId]);
  return rows.map((r) => ({ articleId: Number(r.article_id), nombre: r.nombre, costoHora: Number(r.costo_hora) || 0,
    sucursal: r.sucursal == null ? null : Number(r.sucursal) }));
}

module.exports = { normalizarConfig, calcularAncla, aplicarCostosFamilia, recalcularServicio, listarAnclas, mesesCerrados, RUBROS };
