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

const METODOS = ["unico", "semanas", "dias_mes"];
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
function promedioPorDia(s, corteMs) {
  const desde = Math.max(corteMs - (VENTANA_DIAS - 1) * DIA_MS, s.primerDia);
  const suma = new Array(7).fill(0);
  const cant = new Array(7).fill(0);
  for (let ms = desde; ms <= corteMs; ms += DIA_MS) {
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
function estacionalidad(s, anio, mes, dia) {
  const hasta = [];
  const resto = [];
  for (let k = 1; k <= ANIOS_ESTACIONALIDAD; k++) {
    const dm = diasDelMes(anio - k, mes);
    const ini = Date.UTC(anio - k, mes - 1, 1);
    const corte = Date.UTC(anio - k, mes - 1, Math.min(dia, dm));
    const fin = Date.UTC(anio - k, mes - 1, dm);
    if (corte - (VENTANA_DIAS - 1) * DIA_MS < s.primerDia) continue;
    const p = promedioPorDia(s, corte);
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
function estimar(s, corteMs, metodo = "semanas") {
  const c = new Date(corteMs);
  const anio = c.getUTCFullYear();
  const mes = c.getUTCMonth() + 1;
  const inicioMes = Date.UTC(anio, mes - 1, 1);
  const finMes = Date.UTC(anio, mes - 1, diasDelMes(anio, mes));

  const prom = promedioPorDia(s, corteMs);

  let esperadoHasta = 0;
  const sumaMes = new Array(7).fill(0);
  const cantMes = new Array(7).fill(0);
  for (let ms = inicioMes; ms <= corteMs; ms += DIA_MS) {
    esperadoHasta += prom[dow(ms)];
    sumaMes[dow(ms)] += venta(s, ms);
    cantMes[dow(ms)] += 1;
  }
  const facturado = sumaMes.reduce((a, b) => a + b, 0);
  const ritmo = esperadoHasta > 0 ? facturado / esperadoHasta : 1;
  const diasMes = diasDelMes(anio, mes);
  const diasTranscurridos = Math.round((corteMs - inicioMes) / DIA_MS) + 1;

  // Método único: base × estacionalidad × ritmo frenado.
  const est = metodo === "unico" ? estacionalidad(s, anio, mes, diasTranscurridos) : null;
  const ritmoBruto = esperadoHasta > 0 ? facturado / (esperadoHasta * (est?.hasta ?? 1)) : 1;
  const ritmoEstacional = 1 + (ritmoBruto - 1) * (diasTranscurridos / (diasTranscurridos + FRENO_RITMO));

  // Con pocos días por delante la estacionalidad de ese tramo es ruidosa (2-3 días de otro año): pesa
  // de a poco, entera recién con 10+ días restantes (backtest: mejora los cortes del 25 en adelante).
  const restantes = diasMes - diasTranscurridos;
  const estResto = est ? 1 + (est.resto - 1) * Math.min(1, restantes / FRENO_ESTACIONAL) : 1;
  let restante = 0;
  for (let ms = corteMs + DIA_MS; ms <= finMes; ms += DIA_MS) {
    const d = dow(ms);
    restante += metodo === "unico" ? prom[d] * estResto * ritmoEstacional
      : metodo === "dias_mes" && cantMes[d] > 0 ? sumaMes[d] / cantMes[d] : prom[d] * ritmo;
  }

  return {
    anio, mes, inicioMes, finMes, diasMes, diasTranscurridos,
    facturado, ritmo, restante, proyeccion: facturado + restante,
    estacional: est ? estResto : null, ritmoEstacional,
    reglaDeTres: diasTranscurridos > 0 ? (facturado / diasTranscurridos) * diasMes : 0,
  };
}

function proyectarMes(
  dias,
  corte,
  guardadas = [],
) {
  if (!dias.length) return null;
  const s = armarSerie(dias);
  const corteMs = aMs(corte);
  const e = estimar(s, corteMs, "semanas");
  const eMes = estimar(s, corteMs, "dias_mes");
  const eUnico = estimar(s, corteMs, "unico");
  const proyecciones = { unico: eUnico.proyeccion, semanas: e.proyeccion, dias_mes: eMes.proyeccion };
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
  const cierreLy = hayLy ? sumaRango(s, lyInicio, lyFin) : 0;
  const lyHasta = hayLy ? sumaRango(s, lyInicio, lyCorte) : 0;

  // Backtest: los meses anteriores, cortados el mismo día del mes.
  const errBt = { unico: [], semanas: [], dias_mes: [] };
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
    for (const m of METODOS) errBt[m].push(Math.abs(estimar(s, bCorte, m).proyeccion - real) / real);
    errR.push(Math.abs(estimar(s, bCorte).reglaDeTres - real) / real);
  }
  const media = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  // Proyecciones guardadas de meses ya cerrados (anteriores al del corte) contra su cierre real.
  const errG = { unico: [], semanas: [], dias_mes: [] };
  const mesesG = new Set ();
  const mesesPorMetodo = { unico: new Set(), semanas: new Set(), dias_mes: new Set() };
  const realMes = new Map ();
  for (const g of guardadas) {
    if (g.anio * 12 + g.mes >= e.anio * 12 + e.mes) continue;
    const clave = `${g.anio}-${g.mes}`;
    if (!realMes.has(clave)) {
      const ini = Date.UTC(g.anio, g.mes - 1, 1);
      realMes.set(clave, ini >= s.primerDia ? sumaRango(s, ini, Date.UTC(g.anio, g.mes - 1, diasDelMes(g.anio, g.mes))) : 0);
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
  if (mesesG.size >= 3 && METODOS.every((m) => mesesPorMetodo[m].size >= 3)) {
    const errores = { unico: media(errG.unico), semanas: media(errG.semanas), dias_mes: media(errG.dias_mes) };
    backtest = { fuente: "guardadas", meses: mesesG.size, dia: e.diasTranscurridos, errorMetodo: 0, errores, errorReglaDeTres: errR.length ? media(errR) : null };
  } else if (errBt.semanas.length) {
    const errores = { unico: media(errBt.unico), semanas: media(errBt.semanas), dias_mes: media(errBt.dias_mes) };
    backtest = { fuente: "backtest", meses: errBt.semanas.length, dia: e.diasTranscurridos, errorMetodo: 0, errores, errorReglaDeTres: media(errR) };
  }
  // Se usa el que menos erró; empate o sin datos → el único.
  const metodo = backtest
    ? METODOS.reduce((m, x) => (backtest.errores[x] < backtest.errores[m] ? x : m), "unico")
    : "unico";
  if (backtest) backtest.errorMetodo = backtest.errores[metodo];
  const elegido = metodo === "unico" ? eUnico : metodo === "semanas" ? e : eMes;

  // Lo ya facturado es seguro: el rango nunca baja de ahí.
  const rango = backtest
    ? { min: elegido.proyeccion * (1 - backtest.errorMetodo), max: elegido.proyeccion * (1 + backtest.errorMetodo) }
    : null;
  if (rango && rango.min < e.facturado) rango.min = e.facturado;

  return {
    anio: e.anio,
    mes: e.mes,
    corte,
    diasMes: e.diasMes,
    diasTranscurridos: e.diasTranscurridos,
    diasRestantes: e.diasMes - e.diasTranscurridos,
    facturado: e.facturado,
    estimadoRestante: elegido.restante,
    proyeccion: elegido.proyeccion,
    metodo,
    proyecciones,
    ritmo: e.ritmo,
    estacional: eUnico.estacional,
    ritmoEstacional: eUnico.ritmoEstacional,
    restantesPorDia: orden.map((d) => ({ dow: d, cantidad: cuenta.get(d) })),
    reglaDeTres: e.reglaDeTres,
    mismoRitmoAnioAnterior: hayLy && lyHasta > 0 && cierreLy > 0 ? cierreLy * (e.facturado / lyHasta) : null,
    cierreAnioAnterior: hayLy && cierreLy > 0 ? cierreLy : null,
    backtest,
    rango,
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

module.exports = { METODOS, proyectarMes, debeProyectar, DIA_SEMANA_CORTO, fmtMillones };
