// services/servicioCosto.js
// Recetas de tipo SERVICIO (Diego 20/11/2026, canchas de Container FC; pensado genérico: horas de cancha,
// noches de hotel, horas de salón, un garage). Un servicio no tiene insumos: su costo sale de los costos
// estructurales del local y de cuánto se usa.
//
// recetas.servicio (JSONB):
//   ancla    { tipo: 'ancla', sucursal: null | branchId, reparto: 'ventas' | 'manual',
//              pct: { alquiler, sueldos, servicios, mercaderias }  (0-100; solo con reparto 'manual'),
//              propios: [codigoConcepto] }  conceptos que son 100 % del servicio (Beelup, césped…)
//            base: { fecha, costoMes, costoHora, precio }  la foto del día del último aumento (opcional)
//   derivado { tipo: 'derivado', ancla: articleId, factor: number, horas?, pctHora? }  (factor = horas ×
//              pctHora ÷ 100; Diego 23/11/2026: el colegio son 40 horas que se cobran juntas). Sin horas:
//              (0,93 = 93 % de la hora de la ancla;
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

/** Foto del día del último aumento: contra ella se mide cuánto subieron los costos (Diego 20/11/2026). */
function normalizarBase(b) {
  if (!b || typeof b !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || ''))) return null;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  if (!n(b.costoMes)) return null;
  return { fecha: String(b.fecha), costoMes: n(b.costoMes), costoHora: n(b.costoHora), precio: n(b.precio) };
}

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
      // Alquiler de otro PDV (Diego 23/11/2026): { sucursal: sucursalDeLaQueSeToma }, claves 'main' o el id.
      alquilerDe: Object.fromEntries(Object.entries(c.alquilerDe && typeof c.alquilerDe === 'object' ? c.alquilerDe : {})
        .map(([k, v]) => [String(k), String(v)])
        .filter(([k, v]) => /^(main|\d+)$/.test(k) && /^(main|\d+)$/.test(v) && k !== v)),
      base: normalizarBase(c.base),
    };
  }
  if (c.tipo === 'derivado') {
    const ancla = Number(c.ancla);
    const horas = Number(c.horas);
    const pctHora = Number(c.pctHora);
    if (Number.isFinite(ancla) && ancla !== 0 && horas > 0 && pctHora > 0) {
      return { tipo: 'derivado', ancla, horas, pctHora, factor: horas * pctHora / 100 };
    }
    const factor = Number(c.factor);
    if (!Number.isFinite(ancla) || ancla === 0 || !(factor > 0)) return null;
    return { tipo: 'derivado', ancla, factor };
  }
  return null;
}

/**
 * Último aumento de precio de la ancla, leído de sus ventas día por día (Diego 23/11/2026: «¿no
 * debería darse cuenta solo del último aumento?»). Precio del día = facturado ÷ unidades. Nivel de
 * hoy = el precio más repetido de los últimos 7 días con ventas. Se camina hacia atrás hasta
 * encontrar 3 días seguidos a un precio más bajo y estable (los días sueltos con descuento o una
 * venta grande no cortan): el aumento es el primer día al nivel nuevo.
 * @param dias [{ fecha, precio }] ordenados por fecha
 * @returns { fecha, antes, despues } | null
 */
function detectarAumento(dias) {
  const ds = (dias || []).filter((d) => d.precio > 0);
  if (ds.length < 10) return null;
  const redondo = (v) => Math.round(v / 100) * 100;
  const moda = (arr) => {
    const c = new Map();
    for (const v of arr) c.set(redondo(v), (c.get(redondo(v)) || 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? null;
  };
  const nivel = moda(ds.slice(-7).map((d) => d.precio));
  if (!nivel) return null;
  const alNivel = (v) => Math.abs(v - nivel) <= nivel * 0.01;
  let i = ds.length - 1;
  let primero = null; // primer día (hacia atrás) visto al nivel de hoy
  while (i >= 0) {
    if (alNivel(ds[i].precio)) { primero = i; i--; continue; }
    // ¿Arranca acá un tramo de 3 días seguidos a un mismo precio más bajo?
    const tramo = ds.slice(Math.max(0, i - 2), i + 1).map((d) => redondo(d.precio));
    const estable = tramo.length === 3 && tramo.every((v) => v === tramo[0]) && tramo[0] < nivel * 0.99;
    if (estable && primero != null) {
      return { fecha: ds[primero].fecha, antes: tramo[0], despues: nivel };
    }
    i--; // día suelto (descuento, venta grande): no corta
  }
  return null;
}

/**
 * Sucursales del negocio para el cálculo por sucursal (Diego 23/11/2026). 'main' = la principal (sus
 * ventas y gastos llegan sin sucursal); el resto, por su id. La principal de app_branches (is_main)
 * también es 'main'.
 */
async function sucursalesDe(db, businessId) {
  const { rows } = await db.query(
    `SELECT id, name, COALESCE((props->>'is_main')::boolean, false) AS principal FROM app_branches
      WHERE business_id = $1 ORDER BY principal DESC, lower(name)`, [businessId]);
  const main = rows.find((r) => r.principal);
  const out = [{ key: 'main', id: main ? Number(main.id) : null, nombre: main?.name || 'Principal' }];
  for (const r of rows) if (!r.principal) out.push({ key: String(r.id), id: Number(r.id), nombre: r.name });
  return out;
}
const claveSucursal = (v, sucs) => {
  if (v == null || v === '' || v === 'main' || v === 'none') return 'main';
  if (v === 'all') return 'all';
  const n = Number(v);
  const m = sucs.find((x) => x.id === n);
  return !m ? 'main' : m.key;
};

/** «Todas»: la suma de las sucursales (gastos, horas y costo del mes); la hora = costo ÷ horas. */
function sumarSucursales(partes, sucs) {
  const base = partes.find((p) => p.sucursal === 'main') || partes[0];
  const sum = (f) => partes.reduce((a, p) => a + (Number(f(p)) || 0), 0);
  const costoMes = sum((p) => p.costoMes);
  const horas = sum((p) => p.horas);
  const costoHora = horas > 0 ? costoMes / horas : 0;
  const h3 = partes.every((p) => p.horasUltimos3 == null) ? null : sum((p) => p.horasUltimos3);
  const vLocal = sum((p) => p.meses.reduce((a, m) => a + m.ventasLocal, 0));
  const vServ = sum((p) => p.meses.reduce((a, m) => a + m.ventasServicio, 0));
  const rubros = base.rubros.map((r) => {
    const deTodas = partes.map((p) => p.rubros.find((x) => x.clave === r.clave)).filter(Boolean);
    const mensual = deTodas.reduce((a, x) => a + x.mensual, 0);
    const asignado = deTodas.reduce((a, x) => a + x.asignado, 0);
    const propios = new Map();
    for (const x of deTodas) for (const pr of x.propios) propios.set(pr.codigo, { ...pr, mensual: (propios.get(pr.codigo)?.mensual || 0) + pr.mensual });
    return { ...r, mensual, asignado, pct: r.incluido && mensual > 0 ? asignado / mensual * 100 : 0, propios: [...propios.values()] };
  });
  const conceptos = new Map();
  for (const p of partes) for (const c of p.conceptos) conceptos.set(c.codigo, { ...c, mensual: (conceptos.get(c.codigo)?.mensual || 0) + c.mensual });
  const margen = base.precioActual ? 1 - costoHora / base.precioActual : null;
  return {
    ...base, sucursal: 'all', sucursalNombre: 'Todas', sucursales: sucs, alquilerDe: null,
    porSucursal: partes.map((p) => ({ sucursal: p.sucursal, nombre: p.sucursalNombre, costoMes: p.costoMes, horas: p.horas, costoHora: p.costoHora })),
    horas, horasUltimos3: h3, parteVentas: vLocal > 0 ? vServ / vLocal : 0,
    rubros, conceptos: [...conceptos.values()].sort((a, b) => b.mensual - a.mensual), costoMes, costoHora, margen,
    mesesConDatos: Math.max(...partes.map((p) => p.mesesConDatos)),
    familia: base.familia.map((f) => ({ ...f, costo: costoHora * f.factor })),
    sinDatos: horas === 0 || costoMes === 0,
  };
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
async function calcularAncla(businessId, anclaArticleId, { db = pool, configOverride = null, hoy = new Date(), detectar = true, sucursal } = {}) {
  const rec = await recetaDe(db, businessId, anclaArticleId);
  const cfg = normalizarConfig(configOverride || rec?.servicio);
  if (!cfg || cfg.tipo !== 'ancla') return null;

  // Por sucursal (Diego 23/11/2026): sin sucursal pedida = «Todas» (lo que se guarda en la receta).
  const sucs = await sucursalesDe(db, businessId);
  let clave = sucursal === undefined ? 'all' : claveSucursal(sucursal, sucs);
  if (clave === 'all' && sucs.length <= 1) clave = 'main';
  if (clave === 'all') {
    const partes = [];
    for (const x of sucs) {
      partes.push(await calcularAncla(businessId, anclaArticleId, { db, configOverride: cfg, hoy, detectar: detectar && x.key === 'main', sucursal: x.key }));
    }
    return sumarSucursales(partes.filter(Boolean), sucs);
  }
  const mainId = sucs[0].id;
  const claveDe = (b) => (b == null || Number(b) === mainId ? 'main' : String(b));
  const alquilerDe = cfg.alquilerDe?.[clave] && sucs.some((x) => x.key === cfg.alquilerDe[clave]) ? cfg.alquilerDe[clave] : clave;

  const { rows: bizRows } = await db.query(`SELECT organization_id FROM app_businesses WHERE id = $1`, [businessId]);
  const orgId = Number(bizRows[0]?.organization_id) || null;

  // Familia: la ancla (factor 1) + los derivados del negocio que la eligieron.
  const { rows: der } = await db.query(
    `SELECT r.article_id, r.nombre, (r.servicio->>'factor')::float8 AS factor,
            (r.servicio->>'horas')::float8 AS horas, (r.servicio->>'pctHora')::float8 AS pct_hora
       FROM recetas r
      WHERE r.business_id = $1 AND r.active = TRUE AND r.servicio->>'tipo' = 'derivado'
        AND (r.servicio->>'ancla')::bigint = $2
      ORDER BY r.nombre`, [businessId, anclaArticleId]);
  const familia = [{ articleId: Number(anclaArticleId), nombre: rec?.nombre || null, factor: 1, ancla: true },
    ...der.map((d) => ({ articleId: Number(d.article_id), nombre: d.nombre, factor: Number(d.factor) || 0, ancla: false,
      horas: Number(d.horas) > 0 ? Number(d.horas) : null, pctHora: Number(d.pct_hora) > 0 ? Number(d.pct_hora) : null }))];
  const ids = familia.map((f) => f.articleId);

  const suc = clave === 'main' ? null : Number(clave);
  const lugarVentas = suc == null ? (mainId ? `(branch_id IS NULL OR branch_id = ${Number(mainId)})` : 'branch_id IS NULL') : 'branch_id = $4';

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
  // Gastos de todas las sucursales: el alquiler puede salir de otro PDV (cfg.alquilerDe).
  const paramsC = [businessId, desdeC, hastaC, orgId];
  const { rows: costosTodas } = orgId ? await db.query(
    `SELECT v.branch_id AS b, cc."codRga" AS r, cc.codigo, cc.nombre,
            SUM(COALESCE(v."importeManual", v.importe))::float8 AS total,
            COUNT(DISTINCT to_char(date_trunc('month', COALESCE(v."fechaManual", v.periodo, v.fecha)), 'YYYY-MM'))::int AS meses
       FROM gestion_v_compras_distribuidas v
       JOIN gestion_conceptos_caja cc ON cc.organization_id = $4
                                     AND cc.codigo = COALESCE(v."conceptoCodigoManual", v."conceptoCodigo")
      WHERE v.business_id = $1
        AND COALESCE(v."fechaManual", v.periodo, v.fecha) >= $2::timestamp
        AND COALESCE(v."fechaManual", v.periodo, v.fecha) < $3::timestamp
        AND cc."codRga" IN ('1', '2', '3', '21')
      GROUP BY 1, 2, 3, 4`, paramsC) : { rows: [] };
  const sumaPorConcepto = (filas) => {
    const m = new Map();
    for (const c of filas) { const k = `${c.r}|${c.codigo}`; const prev = m.get(k); m.set(k, prev ? { ...prev, total: prev.total + c.total } : { ...c }); }
    return [...m.values()];
  };
  const costos = sumaPorConcepto(costosTodas.filter((c) => (c.r === '21' ? claveDe(c.b) === alquilerDe : claveDe(c.b) === clave)));

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

  // Precio de hoy de la ancla: el del último mes con ventas. Margen = 1 − costo de la hora ÷ precio.
  const precioActual = [...meses].reverse().find((x) => x.precioAncla)?.precioAncla ?? null;
  const margen = precioActual ? 1 - costoHora / precioActual : null;
  // Último aumento: se detecta solo en las ventas de la ancla y
  // la foto es el cálculo con los costos de antes de ese día (Diego 23/11/2026).
  let aumento = null;
  if (detectar) {
    const pDias = [businessId, anclaArticleId, desdeH];
    if (suc != null) pDias.push(suc);
    const { rows: dias } = await db.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS fecha, (SUM(amount) / NULLIF(SUM(qty), 0))::float8 AS precio
         FROM sales_daily_items
        WHERE business_id = $1 AND article_id = $2 AND day >= $3::date AND ${suc == null ? 'branch_id IS NULL' : 'branch_id = $4'}
        GROUP BY day HAVING SUM(qty) > 0 ORDER BY day`, pDias);
    aumento = detectarAumento(dias);
    // Una foto guardada a mano más nueva que el aumento detectado manda; si es más vieja, gana lo detectado.
    if (aumento && !(cfg.base && cfg.base.fecha >= aumento.fecha)) {
      const antes = await calcularAncla(businessId, anclaArticleId, {
        db, configOverride: { ...cfg, base: null }, hoy: new Date(`${aumento.fecha}T12:00:00Z`), detectar: false, sucursal: clave });
      if (antes?.costoMes > 0) {
        cfg.base = { fecha: aumento.fecha, costoMes: antes.costoMes, costoHora: antes.costoHora, precio: aumento.despues, detectado: true, precioAntes: aumento.antes };
      }
    }
  }
  // Contra la foto del último aumento: la hora sube lo mismo que suben los costos del servicio.
  let vsBase = null;
  if (cfg.base) {
    const suba = cfg.base.costoMes > 0 ? costoMes / cfg.base.costoMes - 1 : null;
    const margenBase = cfg.base.precio && cfg.base.costoHora ? 1 - cfg.base.costoHora / cfg.base.precio : null;
    vsBase = {
      desde: cfg.base.fecha, suba, detectado: !!cfg.base.detectado,
      precioAntes: cfg.base.precioAntes ?? null, precioBase: cfg.base.precio ?? null,
      precioSugerido: cfg.base.precio && suba != null ? cfg.base.precio * (1 + suba) : null,
      margenBase,
      margenBajo: margenBase != null && margen != null && margen < margenBase - 0.05,
    };
  }

  return {
    sucursal: clave, sucursalNombre: sucs.find((x) => x.key === clave)?.nombre || null, sucursales: sucs, alquilerDe,
    articleId: Number(anclaArticleId), recetaId: rec?.id ?? null, config: cfg,
    precioActual, margen, vsBase,
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

module.exports = { sucursalesDe, claveSucursal, sumarSucursales, detectarAumento, normalizarBase, normalizarConfig, calcularAncla, aplicarCostosFamilia, recalcularServicio, listarAnclas, mesesCerrados, RUBROS };
