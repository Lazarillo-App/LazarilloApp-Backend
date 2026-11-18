// Portado de lazarillo_gestion/lib/dashboard/proyeccion.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Proyección de cierre de un mes con ventas incompletas (tooltip de Ingresos).
//
// Método ÚNICO (Diego 30/10/2026: "tenemos que tener un único método que contemple todo"):
//    cada día que falta = lo que suele vender ese día de la semana (8 semanas)
//    × ESTACIONALIDAD (cuánto se apartó ese mismo tramo del mes, en los 2 años
//    anteriores, de lo que su propia base de 8 semanas decía: vacaciones de
//    invierno, diciembre, etc.; con menos de 10 días por delante pesa de a poco) ×
//    RITMO del mes contra lo esperado con esa estacionalidad, frenado al principio
//    del mes (con pocos días pesa poco).
//    Backtest con las ventas reales 2025–sep 2026, cortando los días 5/10/15/20/25:
//    Bar 9,0% → 6,3% de error medio (peor caso 50% → 21%), Canchas Ramos 11,2% → 8,9%,
//    San Justo 8,2% → 6,6% (método solo; eligiendo por error real: Bar 9,1% → 6,7%). Los feriados nacionales probados no mejoraban: quedan
//    para cuando esté el calendario del negocio (fechas especiales de RRHH).
// Los dos métodos anteriores se siguen calculando para comparar; se usa el que menos erró en ese local/PDV:
//  - "semanas": cada día que falta vale lo que suele vender ese día de la
//    semana (promedio de las últimas 8 semanas) × el ritmo del mes (lo
//    facturado hasta el corte ÷ lo esperado hasta el corte con ese promedio).
//  - "dias_mes" (idea de Diego): cada día que falta vale el promedio de ese
//    mismo día de la semana dentro del mes en curso. Si ese día todavía no
//    pasó en el mes (ej. el día 3 sin sábados), usa el de "semanas".
// El error de cada uno sale de las proyecciones guardadas día a día (cuando
// hay al menos 3 meses cerrados) o, mientras tanto, de repetir el cálculo en
// los 6 meses anteriores cortando el mismo día. Al lado se informan la regla
// de 3 y "mismo ritmo que el año anterior", y un rango con ese error.
//
// Puro (sin DB): recibe las ventas diarias y la fecha de corte.

                                                         // fecha YYYY-MM-DD

const METODOS = ["unico", "semanas", "dias_mes", "calendario"];
// "calendario" (Diego 14/11/2026): el único + las fechas especiales del calendario de RRHH
// (feriados, vísperas, días cerrados y eventos). Cada tipo de fecha aprende cuánto vende de más
// o de menos con la historia del propio local (3 casos o más; si no, no toca nada) y el método
// solo se usa donde el backtest da menos error, igual que los demás. Backtest 2026: Comercio
// 6,3% → 5,7% (feriado ×0,49); Bar sin mejora (el año anterior ya trae los mismos feriados).
const MIN_CASOS_FECHA = 3;
const MARGEN_CALENDARIO = 0.01;
// Proyección guardada un día cualquiera de un mes (tabla proyecciones_ingresos).

const VENTANA_DIAS = 56; // 8 semanas
const MESES_BACKTEST = 6;
const ANIOS_ESTACIONALIDAD = 2;
const FRENO_RITMO = 14; // con d días del mes, el ritmo pesa d / (d + 14)
const FRENO_ESTACIONAL = 10; // la estacionalidad del resto pesa entera con 10+ días por delante

const DIA_MS = 86_400_000;

function aMs(fecha) {
  const [y, m, d] = fecha.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function aFecha(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function diasDelMes(anio, mes) {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

function dow(ms) {
  return new Date(ms).getUTCDay();
}

function armarSerie(dias) {
  const porDia = new Map ();
  let primerDia = Infinity;
  for (const d of dias) {
    porDia.set(d.fecha, (porDia.get(d.fecha) ?? 0) + d.total);
    const ms = aMs(d.fecha);
    if (ms < primerDia) primerDia = ms;
  }
  return { porDia, primerDia };
}

const venta = (s, ms) => s.porDia.get(aFecha(ms)) ?? 0;

function sumaRango(s, desdeMs, hastaMs) {
  let t = 0;
  for (let ms = desdeMs; ms <= hastaMs; ms += DIA_MS) t += venta(s, ms);
  return t;
}

// Promedio por día de semana en las 8 semanas hasta `corteMs` (los días sin ventas cuentan como 0:
// si el local cierra los lunes, el lunes vale 0).
function promedioPorDia(s, corteMs, cal = null) {
  const desde = Math.max(corteMs - (VENTANA_DIAS - 1) * DIA_MS, s.primerDia);
  const suma = new Array(7).fill(0);
  const cant = new Array(7).fill(0);
  for (let ms = desde; ms <= corteMs; ms += DIA_MS) {
    // Las fechas especiales no entran al promedio (como el «suma al promedio = NO» del Excel).
    if (cal && cal.tipo.has(aFecha(ms))) continue;
    suma[dow(ms)] += venta(s, ms);
    cant[dow(ms)] += 1;
  }
  const dias = cant.reduce((a, b) => a + b, 0);
  const promGeneral = dias > 0 ? suma.reduce((a, b) => a + b, 0) / dias : 0;
  return suma.map((v, i) => (cant[i] > 0 ? v / cant[i] : promGeneral));
}

// Estacionalidad del mes de `corteMs` cortado el día `dia`: en cada uno de los años anteriores, lo que
// vendió el tramo hasta el corte y el resto del mes contra lo que decía su base de 8 semanas.
// Media geométrica de los años con historia completa, acotada a 0,5–2. null si no hay años.
function estacionalidad(s, anio, mes, dia, cal = null) {
  const hasta = [];
  const resto = [];
  for (let k = 1; k <= ANIOS_ESTACIONALIDAD; k++) {
    const dm = diasDelMes(anio - k, mes);
    const ini = Date.UTC(anio - k, mes - 1, 1);
    const corte = Date.UTC(anio - k, mes - 1, Math.min(dia, dm));
    const fin = Date.UTC(anio - k, mes - 1, dm);
    if (corte - (VENTANA_DIAS - 1) * DIA_MS < s.primerDia) continue;
    const p = promedioPorDia(s, corte, cal);
    let bH = 0, bR = 0;
    for (let ms = ini; ms <= corte; ms += DIA_MS) bH += p[dow(ms)];
    for (let ms = corte + DIA_MS; ms <= fin; ms += DIA_MS) bR += p[dow(ms)];
    const aH = sumaRango(s, ini, corte), aR = sumaRango(s, corte + DIA_MS, fin);
    if (bH > 0 && aH > 0) hasta.push(aH / bH);
    if (bR > 0 && aR > 0) resto.push(aR / bR);
  }
  if (!hasta.length && !resto.length) return null;
  const gm = (xs) => (xs.length ? Math.exp(xs.reduce((a, b) => a + Math.log(b), 0) / xs.length) : 1);
  const acotar = (x) => Math.min(2, Math.max(0.5, x));
  return { hasta: acotar(gm(hasta)), resto: acotar(gm(resto)) };
}

// Núcleo: estimación del cierre del mes de `corteMs` usando solo datos hasta el corte.
function estimar(s, corteMs, metodo = "semanas", cal = null) {
  const conCal = metodo === "calendario" && cal ? cal : null;
  const F = (ms) => (conCal ? conCal.factor(aFecha(ms), corteMs) : 1);
  const c = new Date(corteMs);
  const anio = c.getUTCFullYear();
  const mes = c.getUTCMonth() + 1;
  const inicioMes = Date.UTC(anio, mes - 1, 1);
  const finMes = Date.UTC(anio, mes - 1, diasDelMes(anio, mes));

  const prom = promedioPorDia(s, corteMs, conCal);

  let esperadoHasta = 0;
  const sumaMes = new Array(7).fill(0);
  const cantMes = new Array(7).fill(0);
  for (let ms = inicioMes; ms <= corteMs; ms += DIA_MS) {
    esperadoHasta += prom[dow(ms)] * F(ms);
    sumaMes[dow(ms)] += venta(s, ms);
    cantMes[dow(ms)] += 1;
  }
  const facturado = sumaMes.reduce((a, b) => a + b, 0);
  const ritmo = esperadoHasta > 0 ? facturado / esperadoHasta : 1;
  const diasMes = diasDelMes(anio, mes);
  const diasTranscurridos = Math.round((corteMs - inicioMes) / DIA_MS) + 1;

  // Método único: base × estacionalidad × ritmo frenado.
  const comoUnico = metodo === "unico" || metodo === "calendario";
  const est = comoUnico ? estacionalidad(s, anio, mes, diasTranscurridos, conCal) : null;
  const ritmoBruto = esperadoHasta > 0 ? facturado / (esperadoHasta * (est?.hasta ?? 1)) : 1;
  const ritmoEstacional = 1 + (ritmoBruto - 1) * (diasTranscurridos / (diasTranscurridos + FRENO_RITMO));

  // Con pocos días por delante la estacionalidad de ese tramo es ruidosa (2-3 días de otro año): pesa
  // de a poco, entera recién con 10+ días restantes (backtest: mejora los cortes del 25 en adelante).
  const restantes = diasMes - diasTranscurridos;
  const estResto = est ? 1 + (est.resto - 1) * Math.min(1, restantes / FRENO_ESTACIONAL) : 1;
  let restante = 0;
  for (let ms = corteMs + DIA_MS; ms <= finMes; ms += DIA_MS) {
    const d = dow(ms);
    restante += comoUnico ? prom[d] * estResto * ritmoEstacional * F(ms)
      : metodo === "dias_mes" && cantMes[d] > 0 ? sumaMes[d] / cantMes[d] : prom[d] * ritmo;
  }

  return {
    anio, mes, inicioMes, finMes, diasMes, diasTranscurridos,
    facturado, ritmo, restante, proyeccion: facturado + restante,
    estacional: est ? estResto : null, ritmoEstacional,
    reglaDeTres: diasTranscurridos > 0 ? (facturado / diasTranscurridos) * diasMes : 0,
  };
}

// Calendario del negocio: fechas = [{ fecha, tipo: feriado|prefer|evento|cerrado, nombre, fijo }].
// Las inamovibles (fijo) valen también los años anteriores, para aprender con más historia.
// Víspera = el día antes de un feriado que no sea especial él mismo (o un «pre feriado» marcado).
// factor(fecha, corteMs): cuánto vende ese día contra su día de semana normal, aprendido solo con
// fechas ANTERIORES al corte (mediana; 3 casos o más). Cerrado = 0 siempre. null si no hay fechas.
function armarCalendario(s, fechas) {
  if (!fechas || !fechas.length) return null;
  const tipo = new Map(); // fecha → clave
  const nombre = new Map();
  const norm = (t) => String(t || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const clave = (f) => (f.tipo === "prefer" ? "vispera" : f.tipo === "evento" ? `evento:${norm(f.nombre)}` : f.tipo);
  const poner = (fecha, f) => { if (!tipo.has(fecha)) { tipo.set(fecha, clave(f)); nombre.set(fecha, f.nombre || null); } };
  for (const f of fechas) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.fecha || "")) continue;
    poner(f.fecha, f);
    if (f.fijo) for (let k = 1; k <= ANIOS_ESTACIONALIDAD; k++) poner(`${Number(f.fecha.slice(0, 4)) - k}${f.fecha.slice(4)}`, f);
  }
  for (const [f, t] of [...tipo]) {
    if (t !== "feriado") continue;
    const v = aFecha(aMs(f) - DIA_MS);
    if (!tipo.has(v)) { tipo.set(v, "vispera"); nombre.set(v, null); }
  }
  const base = (ms) => {
    let t = 0, n = 0;
    for (let k = 1; k <= 8; k++) {
      const g = ms - 7 * k * DIA_MS;
      if (g < s.primerDia || tipo.has(aFecha(g))) continue;
      t += venta(s, g); n++;
    }
    return n ? t / n : 0;
  };
  const cache = new Map();
  const aprender = (cl, corteMs) => {
    const k = `${cl}|${corteMs}`;
    if (cache.has(k)) return cache.get(k);
    const r = [];
    for (const [f, t] of tipo) {
      const ms = aMs(f);
      if (t !== cl || ms >= corteMs || ms < s.primerDia) continue;
      const b = base(ms);
      if (b > 0) r.push(venta(s, ms) / b);
    }
    r.sort((a, b) => a - b);
    const v = r.length >= MIN_CASOS_FECHA ? r[Math.floor(r.length / 2)] : null;
    cache.set(k, v);
    return v;
  };
  const factorDe = (fecha, corteMs) => {
    const cl = tipo.get(fecha);
    if (!cl) return 1;
    if (cl === "cerrado") return 0;
    let v = aprender(cl, corteMs);
    // Un evento con poca historia propia usa lo que suelen vender los eventos en general.
    if (v == null && cl.startsWith("evento:")) v = aprenderEventos(corteMs);
    return v ?? 1;
  };
  const aprenderEventos = (corteMs) => {
    const k = `evento*|${corteMs}`;
    if (cache.has(k)) return cache.get(k);
    const r = [];
    for (const [f, t] of tipo) {
      const ms = aMs(f);
      if (!t.startsWith("evento:") || ms >= corteMs || ms < s.primerDia) continue;
      const b = base(ms);
      if (b > 0) r.push(venta(s, ms) / b);
    }
    r.sort((a, b) => a - b);
    const v = r.length >= MIN_CASOS_FECHA ? r[Math.floor(r.length / 2)] : null;
    cache.set(k, v);
    return v;
  };
  return { tipo, nombre, factor: factorDe };
}

/**
 * @param dias [{ fecha, total, rec? }] — rec: lo que ese día facturaron los clientes recurrentes.
 * @param recurrentes [{ cliente, esperado, ya }] — facturas grandes que se repiten todos los meses
 *   (Diego 18/11/2026: el colegio y la escuelita de FC). El modelo proyecta las ventas SIN ellas
 *   (no son ventas del día: una factura de $4 M no dice nada del ritmo) y después se suma lo que
 *   ya se les facturó en el mes más lo que falta facturarles.
 */
function proyectarMes(
  dias,
  corte,
  guardadas = [],
  fechas = [],
  recurrentes = [],
) {
  if (!dias.length) return null;
  const s = armarSerie(dias.map((d) => ({ fecha: d.fecha, total: d.total - (d.rec ?? 0) })));
  // Serie completa: para comparar con lo que de verdad cerró cada mes.
  const sReal = armarSerie(dias);
  const corteMs = aMs(corte);
  const cal = armarCalendario(s, fechas);
  const e = estimar(s, corteMs, "semanas");
  const eMes = estimar(s, corteMs, "dias_mes");
  const eUnico = estimar(s, corteMs, "unico");
  const eCal = cal ? estimar(s, corteMs, "calendario", cal) : eUnico;
  const proyecciones = { unico: eUnico.proyeccion, semanas: e.proyeccion, dias_mes: eMes.proyeccion, calendario: eCal.proyeccion };
  if (e.diasTranscurridos >= e.diasMes || e.facturado <= 0) return null;

  // Días que faltan agrupados por día de semana, en orden de aparición.
  const orden = [];
  const cuenta = new Map ();
  for (let ms = corteMs + DIA_MS; ms <= e.finMes; ms += DIA_MS) {
    const d = dow(ms);
    if (!cuenta.has(d)) orden.push(d);
    cuenta.set(d, (cuenta.get(d) ?? 0) + 1);
  }

  // Mismo mes del año anterior.
  const lyInicio = Date.UTC(e.anio - 1, e.mes - 1, 1);
  const lyDias = diasDelMes(e.anio - 1, e.mes);
  const lyFin = Date.UTC(e.anio - 1, e.mes - 1, lyDias);
  const lyCorte = Date.UTC(e.anio - 1, e.mes - 1, Math.min(e.diasTranscurridos, lyDias));
  const hayLy = s.primerDia <= lyInicio;
  const cierreLy = hayLy ? sumaRango(sReal, lyInicio, lyFin) : 0;
  const lyHasta = hayLy ? sumaRango(sReal, lyInicio, lyCorte) : 0;

  // Backtest: los meses anteriores, cortados el mismo día del mes.
  const errBt = { unico: [], semanas: [], dias_mes: [], calendario: [] };
  const errR = [];
  for (let k = 1; k <= MESES_BACKTEST; k++) {
    const a = new Date(Date.UTC(e.anio, e.mes - 1 - k, 1));
    const ba = a.getUTCFullYear();
    const bm = a.getUTCMonth() + 1;
    const bDias = diasDelMes(ba, bm);
    const bInicio = Date.UTC(ba, bm - 1, 1);
    // Necesita la ventana completa de historia antes del corte para ser comparable.
    const bCorte = Date.UTC(ba, bm - 1, Math.min(e.diasTranscurridos, bDias - 1));
    if (bCorte - (VENTANA_DIAS - 1) * DIA_MS < s.primerDia) break;
    const real = sumaRango(s, bInicio, Date.UTC(ba, bm - 1, bDias));
    if (real <= 0) continue;
    for (const m of METODOS) errBt[m].push(Math.abs((m === "calendario" && !cal ? estimar(s, bCorte, "unico") : estimar(s, bCorte, m, cal)).proyeccion - real) / real);
    errR.push(Math.abs(estimar(s, bCorte).reglaDeTres - real) / real);
  }
  const media = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  // Proyecciones guardadas de meses ya cerrados (anteriores al del corte) contra su cierre real.
  const errG = { unico: [], semanas: [], dias_mes: [], calendario: [] };
  const mesesG = new Set ();
  const mesesPorMetodo = { unico: new Set(), semanas: new Set(), dias_mes: new Set(), calendario: new Set() };
  const realMes = new Map ();
  for (const g of guardadas) {
    if (g.anio * 12 + g.mes >= e.anio * 12 + e.mes) continue;
    const clave = `${g.anio}-${g.mes}`;
    if (!realMes.has(clave)) {
      const ini = Date.UTC(g.anio, g.mes - 1, 1);
      realMes.set(clave, ini >= sReal.primerDia ? sumaRango(sReal, ini, Date.UTC(g.anio, g.mes - 1, diasDelMes(g.anio, g.mes))) : 0);
    }
    const real = realMes.get(clave);
    if (real <= 0 || !errG[g.metodo]) continue;
    errG[g.metodo].push(Math.abs(g.proyeccion - real) / real);
    mesesG.add(clave);
    mesesPorMetodo[g.metodo].add(clave);
  }

  let backtest = null;
  // Lo guardado manda cuando CADA método tiene 3+ meses cerrados medidos (el único empezó a
  // guardarse el 30/10/2026: hasta entonces se compara por backtest, en igualdad de condiciones).
  // Sin calendario cargado, "calendario" es igual al único y no compite.
  const candidatos = cal ? METODOS : METODOS.filter((m) => m !== "calendario");
  if (mesesG.size >= 3 && candidatos.every((m) => mesesPorMetodo[m].size >= 3)) {
    const errores = Object.fromEntries(METODOS.map((m) => [m, media(errG[m])]));
    backtest = { fuente: "guardadas", meses: mesesG.size, dia: e.diasTranscurridos, errorMetodo: 0, errores, errorReglaDeTres: errR.length ? media(errR) : null };
  } else if (errBt.semanas.length) {
    const errores = Object.fromEntries(METODOS.map((m) => [m, media(errBt[m])]));
    backtest = { fuente: "backtest", meses: errBt.semanas.length, dia: e.diasTranscurridos, errorMetodo: 0, errores, errorReglaDeTres: media(errR) };
  }
  // Se usa el que menos erró; empate o sin datos → el único.
  // El calendario tiene que ganar por 1 punto: con pocas fechas el backtest es ruidoso (2026:
  // Comercio 6,5% → 5,8%, Bar 8,6% → 8,8%; sin margen el Bar empeoraba a 9,2%).
  const metodo = backtest
    ? candidatos.reduce((m, x) => ((x === "calendario" ? backtest.errores[x] + MARGEN_CALENDARIO : backtest.errores[x]) < backtest.errores[m] ? x : m), "unico")
    : "unico";
  if (backtest) backtest.errorMetodo = backtest.errores[metodo];
  const elegido = { unico: eUnico, semanas: e, dias_mes: eMes, calendario: eCal }[metodo];

  // Fechas especiales que faltan en el mes, con cuánto se espera que vendan (aplicadas o no).
  const fechasRestantes = [];
  if (cal) {
    for (let ms = corteMs + DIA_MS; ms <= e.finMes; ms += DIA_MS) {
      const f = aFecha(ms);
      const cl = cal.tipo.get(f);
      if (!cl) continue;
      fechasRestantes.push({
        fecha: f,
        tipo: cl.startsWith("evento:") ? "evento" : cl,
        nombre: cal.nombre.get(f) || null,
        factor: cal.factor(f, corteMs),
      });
    }
  }

  // Facturas recurrentes: lo ya facturado este mes + lo que falta facturarles (Diego 18/11/2026).
  const recur = recurrentes.map((r) => ({ ...r, pendiente: Math.max(0, r.esperado - r.ya) }));
  const recYa = recur.reduce((a, r) => a + r.ya, 0);
  const recPendiente = recur.reduce((a, r) => a + r.pendiente, 0);
  const extra = recYa + recPendiente;
  const facturado = e.facturado + recYa;
  for (const m of METODOS) proyecciones[m] += extra;

  // Lo ya facturado es seguro: el rango nunca baja de ahí.
  const rango = backtest
    ? { min: elegido.proyeccion * (1 - backtest.errorMetodo) + extra, max: elegido.proyeccion * (1 + backtest.errorMetodo) + extra }
    : null;
  if (rango && rango.min < facturado) rango.min = facturado;

  return {
    anio: e.anio,
    mes: e.mes,
    corte,
    diasMes: e.diasMes,
    diasTranscurridos: e.diasTranscurridos,
    diasRestantes: e.diasMes - e.diasTranscurridos,
    facturado,
    estimadoRestante: elegido.restante + recPendiente,
    proyeccion: elegido.proyeccion + extra,
    metodo,
    proyecciones,
    ritmo: e.ritmo,
    estacional: eUnico.estacional,
    ritmoEstacional: eUnico.ritmoEstacional,
    restantesPorDia: orden.map((d) => ({ dow: d, cantidad: cuenta.get(d) })),
    reglaDeTres: e.reglaDeTres + extra,
    mismoRitmoAnioAnterior: hayLy && lyHasta > 0 && cierreLy > 0 ? cierreLy * (facturado / lyHasta) : null,
    cierreAnioAnterior: hayLy && cierreLy > 0 ? cierreLy : null,
    backtest,
    rango,
    conCalendario: !!cal,
    fechasRestantes,
    recurrentes: recur,
  };
}

// Decide si hay que proyectar: el último día con ventas cae antes de fin de mes
// y ese mes es el actual (o el anterior durante los primeros días, mientras
// se termina de importar). Un PDV que dejó de vender hace meses no se proyecta.
function debeProyectar(ultimoDia, hoy) {
  if (!ultimoDia) return false;
  const [uy, um, ud] = ultimoDia.split("-").map(Number);
  if (ud >= diasDelMes(uy, um)) return false;
  const [hy, hm, hd] = hoy.split("-").map(Number);
  const mesesAtras = (hy - uy) * 12 + (hm - um);
  if (mesesAtras === 0) return true;
  return mesesAtras === 1 && hd <= 7;
}

const DIA_SEMANA_CORTO = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

// "$ 95,2 M" — compacto para el chip.
function fmtMillones(v) {
  if (Math.abs(v) >= 1_000_000) {
    return `$ ${(v / 1_000_000).toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} M`;
  }
  return `$ ${Math.round(v / 1000).toLocaleString("es-AR")} mil`;
}

module.exports = { METODOS, proyectarMes, debeProyectar, DIA_SEMANA_CORTO, fmtMillones, armarCalendario };
