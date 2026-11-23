// services/foodCostProyeccion.js
// Food cost del mes en curso proyectado a fin de mes (Diego 20/11/2026: «las compras y ventas del
// food cost deben estar proyectadas» y «en la víspera de un feriado se compra de más porque cambian
// los cronogramas de entrega de los proveedores, y se suele compensar la semana que le sigue»).
//
// Antes el gráfico hacía una regla de tres (lo del mes × días del mes / días cerrados). Con dos
// semanas seguidas de feriados (9/11 y 23/11) eso daba +7 puntos de food cost que no existían.
//
//   Ventas: el método único de Resultados (proyeccion.js, con el calendario único de feriados por
//           zona) sobre las ventas del POS de cada día.
//   Compras: lo cargado hasta el corte + los días que faltan a ritmo «normal» de cada día de la
//           semana (promedio de las últimas 8 semanas, sin las semanas de feriado), corregido por el
//           EFECTO VÍSPERA que aprende cada local de su propia historia: cuánto compra de más la semana
//           antes de un feriado y cuánto de menos (o de más) la semana que le sigue, contra sus 4
//           semanas anteriores. Feriados seguidos (≤3 días) cuentan como uno. Mínimo 3 feriados con
//           historia; si no, no se corrige nada (sin historia no se deduce).
//   Backtest Bar Ramos (12 meses, cortes 12/19/24, rubros del food cost): regla de tres 7,5% de error,
//   ritmo por día 4,7%, con víspera 4,4%.
//
// Devuelve FACTORES (proyectado ÷ lo cargado del mes): el front ya filtra las compras y ventas por la
// regla de cada KPI y solo multiplica.
const pool = require('../config/db');
const { proyectarMes } = require('./gestion/dashboard/proyeccion');
const { feriadosDe } = require('./feriadosService');

const DIA = 864e5;
const ms = (f) => Date.parse(`${f}T00:00:00Z`);
const iso = (m) => new Date(m).toISOString().slice(0, 10);
const mediana = (a) => {
  const s = [...a].sort((x, y) => x - y); const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
};

/** Feriados seguidos (a 3 días o menos) = un solo evento; ancla = el primero. */
function eventos(fechas) {
  const ev = [];
  for (const f of [...new Set(fechas)].sort()) {
    const u = ev[ev.length - 1];
    if (u && ms(f) - ms(u.fin) <= 3 * DIA) u.fin = f; else ev.push({ ini: f, fin: f });
  }
  return ev;
}

/**
 * Compras del mes del corte proyectadas a fin de mes.
 * @param serie { 'YYYY-MM-DD': importe } — compras por día (puede traer días después del corte).
 * @param corte 'YYYY-MM-DD' — último día cerrado.
 * @param feriados ['YYYY-MM-DD'] — calendario del negocio.
 */
function proyectarCompras(serie, corte, feriados, { semanasBase = 8 } = {}) {
  const S = new Map(Object.entries(serie).map(([k, v]) => [k, Number(v) || 0]));
  if (!S.size) return null;
  const v = (m) => S.get(iso(m)) || 0;
  const semana = (m0) => { let s = 0; for (let i = 0; i < 7; i++) s += v(m0 + i * DIA); return s; };
  const c = ms(corte);
  const primer = Math.min(...[...S.keys()].map(ms));
  const ev = eventos(feriados);
  const enVentana = (m) => ev.some((e) => m >= ms(e.ini) - 7 * DIA && m < ms(e.ini) + 7 * DIA);

  // Efecto víspera aprendido de la historia del local.
  const pre = [], post = [];
  for (const e of ev) {
    const H = ms(e.ini);
    if (H + 6 * DIA > c || H - 35 * DIA < primer) continue;
    const base = [1, 2, 3, 4].reduce((a, k) => a + semana(H - 7 * DIA - 7 * k * DIA), 0) / 4;
    if (base <= 0) continue;
    pre.push(semana(H - 7 * DIA) / base - 1);
    post.push(semana(H) / base - 1);
  }
  const vispera = pre.length >= 3 ? { antes: mediana(pre), despues: mediana(post), feriados: pre.length } : null;

  // Ritmo normal por día de la semana: últimas N semanas antes del corte, sin semanas de feriado.
  const porDow = Array.from({ length: 7 }, () => []);
  for (let m = c - semanasBase * 7 * DIA + DIA; m <= c; m += DIA) {
    if (m >= primer && !enVentana(m)) porDow[new Date(m).getUTCDay()].push(v(m));
  }
  const conHistoria = porDow.filter((a) => a.length).length === 7 && c - primer >= 28 * DIA;
  if (!conHistoria) return null;
  const ritmo = porDow.map((a) => a.reduce((x, y) => x + y, 0) / a.length);

  const d = new Date(c);
  const ini = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const fin = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
  let hasta = 0, cargadoDespues = 0;
  for (let m = ini; m <= fin; m += DIA) { if (m <= c) hasta += v(m); else cargadoDespues += v(m); }
  let restante = 0, restanteSinVispera = 0;
  for (let m = c + DIA; m <= fin; m += DIA) {
    const b = ritmo[new Date(m).getUTCDay()];
    let f = 1;
    if (vispera) for (const e of ev) {
      const H = ms(e.ini);
      if (m >= H - 7 * DIA && m < H) f = 1 + vispera.antes;
      else if (m >= H && m < H + 7 * DIA) f = 1 + vispera.despues;
    }
    restante += b * f; restanteSinVispera += b;
  }
  // Lo ya cargado con fecha posterior al corte (facturas adelantadas) es piso de lo que falta.
  const proyeccion = hasta + Math.max(restante, cargadoDespues);
  return {
    hasta, cargado: hasta + cargadoDespues, proyeccion,
    sinVispera: hasta + Math.max(restanteSinVispera, cargadoDespues),
    vispera,
    feriadosDelMes: ev.filter((e) => ms(e.ini) + 7 * DIA > ini && ms(e.ini) - 7 * DIA <= fin).map((e) => e.ini),
  };
}

const ymd = (dt) => dt.toISOString().slice(0, 10);

/**
 * GET /api/purchases/food-cost-proyeccion?rubros=CARNES|LÁCTEOS&branch_id=
 * rubros: los de las compras que mira el KPI (separados por |); vacío = todas las compras.
 */
async function proyeccionFoodCost({ businessId, rubros = [], branchId = null }) {
  // Corte = último día con ventas del POS, hasta ayer (hora Argentina).
  const ayer = ymd(new Date(Date.now() - 3 * 3600e3 - DIA));
  const { rows: [u] } = await pool.query(
    `SELECT to_char(max(day),'YYYY-MM-DD') AS ult FROM sales_daily_items
      WHERE business_id = $1 AND day <= $2::date AND day >= $2::date - 40`, [businessId, ayer]);
  const corte = u?.ult;
  if (!corte || corte.slice(0, 7) !== ayer.slice(0, 7)) return null;
  const [y, m] = corte.split('-').map(Number);
  const finMes = ymd(new Date(Date.UTC(y, m, 0)));
  if (corte >= finMes) return null;
  const desdeVentas = ymd(new Date(Date.UTC(y - 2, m - 3, 1)));
  const desdeCompras = ymd(new Date(Date.UTC(y - 1, m - 2, 1)));

  const paramsC = [businessId, desdeCompras, finMes];
  let filtroRubro = '', filtroSuc = '';
  if (rubros.length) { paramsC.push(rubros); filtroRubro = `AND COALESCE(ir.nombre, NULLIF(i.rubro, ''), 'Sin rubro') = ANY($${paramsC.length}::text[])`; }
  if (branchId === 'none') filtroSuc = 'AND p.branch_id IS NULL';
  else if (branchId != null && branchId !== 'all' && Number.isFinite(Number(branchId))) {
    paramsC.push(Number(branchId)); filtroSuc = `AND p.branch_id = $${paramsC.length}`;
  }

  const [ventas, compras, fechas] = await Promise.all([
    pool.query(
      `SELECT to_char(day,'YYYY-MM-DD') AS fecha, SUM(amount)::float8 AS total
         FROM sales_daily_items WHERE business_id = $1 AND day >= $2::date AND day <= $3::date
        GROUP BY day ORDER BY day`, [businessId, desdeVentas, corte]).then((r) => r.rows),
    pool.query(
      `SELECT to_char(pi.fecha,'YYYY-MM-DD') AS fecha, SUM(pi.precio_total + COALESCE(pi.iva_total_item, 0))::float8 AS total
         FROM purchase_items pi
         JOIN purchases p ON p.id = pi.purchase_id
         JOIN insumos i ON i.id = pi.insumo_id
         LEFT JOIN insumo_rubros ir ON ir.business_id = i.business_id AND ir.codigo::text = i.rubro
        WHERE pi.business_id = $1 AND pi.fecha >= $2::date AND pi.fecha <= $3::date ${filtroRubro} ${filtroSuc}
        GROUP BY 1`, paramsC).then((r) => r.rows),
    feriadosDe(businessId, {}).catch(() => []),
  ]);

  // Misma fuente que el Panel (Diego 23/11/2026): por día, lo que falta de cada concepto de los rubros
  // del KPI (gastos varios, renglones sin insumo, cargas en Lazarillo, repartos).
  try {
    const aj = await require('./foodCostAjustes').ajustesFoodCost({ businessId, desde: desdeCompras, hasta: finMes, branchId, agrupar: 'dia' });
    const porDia = new Map(compras.map((r) => [r.fecha, r]));
    for (const a of aj) {
      if (rubros.length && !rubros.includes(a.rubro)) continue;
      const r = porDia.get(a.periodo) || { fecha: a.periodo, total: 0 };
      r.total += a.importe;
      if (!porDia.has(a.periodo)) { porDia.set(a.periodo, r); compras.push(r); }
    }
  } catch (e) { console.error('[foodCostProyeccion] ajustes', e.message); }

  const mes = corte.slice(0, 7);
  const diasMes = Number(finMes.slice(8)), cerrados = Number(corte.slice(8));
  const ventasMes = ventas.filter((r) => r.fecha.startsWith(mes)).reduce((a, r) => a + r.total, 0);

  // Ventas: método único con el calendario (sin guardar: eso es de Resultados).
  let pv = null;
  try {
    pv = proyectarMes(ventas.map((r) => ({ fecha: r.fecha, total: r.total })), corte, [],
      fechas.map((f) => ({ fecha: f.fecha, tipo: f.tipo, nombre: f.nombre, fijo: !!f.fijo })), []);
  } catch (e) { console.error('[foodCostProyeccion] ventas', e.message); }
  const ventasProy = pv?.proyeccion > 0 ? pv.proyeccion : (ventasMes * diasMes) / cerrados;

  const feriados = fechas.filter((f) => f.tipo === 'feriado').map((f) => f.fecha);
  const pc = proyectarCompras(Object.fromEntries(compras.map((r) => [r.fecha, r.total])), corte, feriados);
  const comprasMes = compras.filter((r) => r.fecha.startsWith(mes)).reduce((a, r) => a + r.total, 0);
  const comprasProy = pc ? pc.proyeccion : (comprasMes * diasMes) / cerrados;

  const fx = (p, h) => (h > 0 ? p / h : null);
  return {
    mes, corte, cerrados, diasMes,
    ventas: { cargado: ventasMes, proyeccion: ventasProy, factor: fx(ventasProy, ventasMes), metodo: pv ? 'calendario' : 'regla3' },
    compras: {
      cargado: comprasMes, proyeccion: comprasProy, factor: fx(comprasProy, comprasMes),
      metodo: pc ? (pc.vispera ? 'vispera' : 'ritmo') : 'regla3',
      sinVispera: pc?.sinVispera ?? null, vispera: pc?.vispera ?? null, feriadosDelMes: pc?.feriadosDelMes ?? [],
    },
  };
}

module.exports = { proyeccionFoodCost, proyectarCompras, eventos };
