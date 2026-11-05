// Portado de lazarillo_gestion/lib/dashboard/resultados-calc.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Lógica pura de cálculo para la pantalla Resultados — sin dependencias de React,
// para poder testear la aritmética financiera sin renderizar componentes.

// Acepta coma o punto como separador decimal (formato es-AR: "1234,56" o "1234.56").
// Si hay coma, el punto se interpreta como separador de miles ("1.234,56" -> 1234.56).
function parseMontoARS(raw) {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  const normalized = trimmed.includes(",")
    ? trimmed.replace(/\./g, "").replace(",", ".")
    : trimmed;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

// ¿El usuario tipeó un cero explícito? Un arqueo en $0 no es un dato de caja
// válido (ver spec 2026-08-31-arqueo-cero-no-es-dato): "sin arqueo" se expresa
// dejando la celda vacía, no escribiendo 0. La celda vacía NO cuenta acá — el
// vacío borra la fila y es el camino válido. Guarda de UI: el server igual
// trata `monto: 0` como "borrar", pero acá bloqueamos el 0 tipeado para que no
// se guarde en silencio y desaparezca.
function montoNoGuardable(raw) {
  return raw.trim() !== "" && parseMontoARS(raw) === 0;
}

function pctSobreIngresos(numerador, denominador) {
  return denominador > 0 ? `${((numerador / denominador) * 100).toFixed(1)}%` : "—";
}

// Diferencia de caja acumulada. El acumulador arranca en el mes siguiente al primer arqueo
// cargado (`primerArqueo`) y suma, mes a mes, la VARIACIÓN del Disponible en caja respecto del
// último arqueo conocido, menos el término contable del mes ((ingresos - egresos) - ganancia).
// El Disponible es un stock/balance, no un flujo: sumar el saldo crudo reproduce el runaway del
// 13-ago (ver fix del 24-ago-2026), por eso se acumula la variación. `referencia` arrastra el
// último Disponible conocido a través de los meses sin arqueo propio. Un Disponible null o 0 se
// trata como "sin arqueo ese mes" (ver spec 2026-08-31): no aporta variación ni pisa la referencia.
//
// DISPLAY (cambio 2026-09-09, ver spec 2026-09-09-diferencia-caja-gate-por-arqueo-y-endpoint-unico):
// una celda solo muestra un valor si ESE mes tiene un arqueo real cargado. Un mes sin arqueo
// devuelve null aunque el acumulador ya tenga un valor corriente — revierte la parte de DISPLAY
// de CA-03 del spec del 24-ago (que mostraba el acumulado en todos los meses posteriores al primer
// arqueo). La CONTINUIDAD de CA-03 se preserva: un arqueo posterior reconcilia contra el último
// arqueo real, arrastrando el término contable de los meses intermedios.
//
// Antes o en el mes del primer arqueo, y si no hay ningún arqueo cargado, el resultado es null
// (nunca 0 — ver Fix_Diferencia_Caja.pdf sección 5.1/CA-04).
function computeDiferenciaCajaAcumulada(
  serie,
  primerArqueo,
) {
  const resultado = serie.map(() => null);
  if (primerArqueo == null) return resultado;

  const i0 = serie.findIndex((m) => m.anio === primerArqueo.anio && m.mes === primerArqueo.mes);
  if (i0 === -1) return resultado;

  let referencia = serie[i0].disponible ?? 0;
  let acc = 0;
  for (let i = i0 + 1; i < serie.length; i++) {
    const m = serie[i];
    // Un disponible en 0 es "sin arqueo ese mes" (ver spec 2026-08-31), igual que null:
    // no aporta variación y no pisa la referencia del último arqueo conocido.
    const arqueo = m.disponible !== 0 ? m.disponible : null;
    const deltaDisponible = arqueo != null ? arqueo - referencia : 0;
    if (arqueo != null) referencia = arqueo;
    acc += deltaDisponible - ((m.ingresos - m.egresos) - m.ganancia);
    // Solo se MUESTRA el acumulado en meses con arqueo real cargado (ver spec 2026-09-09).
    // `acc` y `referencia` ya se actualizaron arriba: la continuidad no se corta.
    resultado[i] = arqueo != null ? acc : null;
  }
  return resultado;
}

// Diferencia de caja POR MES (spec 2026-09-16, reemplaza el acumulado como valor principal).
// Cada mes con arqueo es independiente: valor = (arqueo - referencia) - término contable DEL MES
// ACTUAL únicamente. `referencia` (último arqueo real conocido) se arrastra igual que en
// computeDiferenciaCajaAcumulada — mismo criterio de "$0/null = sin dato" (spec 2026-08-31).
//
// Decisión confirmada 2026-09-16: en un hueco de 2+ meses sin arqueo, el término contable que se
// resta al cerrar el hueco es SOLO el del mes que cierra, no la suma de los meses ocultos — lectura
// literal de la fórmula del PDF. Esto difiere del modelo acumulado (que sí arrastra el término
// contable de los meses ocultos, ver computeDiferenciaCajaAcumulada arriba); es una decisión de
// negocio, no un bug — ver spec 2026-09-16-diferencia-caja-por-mes-design.md §1.3.
function computeDiferenciaCajaPorMes(
  serie,
  primerArqueo,
) {
  const resultado = serie.map(() => null);
  if (primerArqueo == null) return resultado;

  const i0 = serie.findIndex((m) => m.anio === primerArqueo.anio && m.mes === primerArqueo.mes);
  if (i0 === -1) return resultado;

  let referencia = serie[i0].disponible ?? 0;
  for (let i = i0 + 1; i < serie.length; i++) {
    const m = serie[i];
    const arqueo = m.disponible !== 0 ? m.disponible : null;
    if (arqueo == null) continue; // sin arqueo este mes: referencia y resultado[i] no se tocan
    const deltaDisponible = arqueo - referencia;
    referencia = arqueo;
    resultado[i] = deltaDisponible - ((m.ingresos - m.egresos) - m.ganancia);
  }
  return resultado;
}

// Suma los valores mensuales visibles de Diferencia de caja para el total anual (spec 2026-09-16
// §1.4). Arranca en null (sin datos) y se vuelve un número en cuanto aparece el primer mes con
// valor — así un total real de $0 (ej. +500 y -500) no se confunde con "ningún mes cargado".
function sumarDiferenciaCajaVisible(valores) {
  let total = null;
  for (const v of valores) {
    if (v != null) total = (total ?? 0) + v;
  }
  return total;
}

// Paleta única de la pantalla Resultados — un solo tono por color, reusado tanto para fondos
// (con texto blanco encima, ver FILL_BAND) como para texto plano (Diferencia de caja,
// Societario, % Rentabilidad). El ámbar es amarillo puro (R=G, B=0 → hue 60°, 100% saturado) sin
// respetar el piso de contraste habitual (~1.8:1 sobre blanco, por debajo del mínimo de 3:1 para
// texto — a propósito, ver commit/feedback de color) — priorizando que se vea "amarillo típico".
const RESULT_COLORS = {
  negative: "#D64545",
  neutral:  "#AAAA00",
  positive: "#159457",
  noData:   "#bdbbb2",
};

// Fondo + texto para el heatmap de Ingresos/Ganancia — los 3 tonos de RESULT_COLORS son
// suficientemente oscuros (luminancia BT.601 < 150) como para llevar siempre texto blanco.
const FILL_BAND = {
  negative: { background: RESULT_COLORS.negative, foreground: "#ffffff" },
  neutral:  { background: RESULT_COLORS.neutral,  foreground: "#ffffff" },
  positive: { background: RESULT_COLORS.positive, foreground: "#ffffff" },
};

// Cuantiza un ratio 0..1 a 3 bandas discretas en vez de un degradé continuo — "que el cuadro
// se entienda de un vistazo, sin colores de más" (criterio explícito del cliente).
function band(ratio) {
  return ratio < 1 / 3 ? "negative" : ratio < 2 / 3 ? "neutral" : "positive";
}

// Ratio (0..1) para una escala relativa por fila: 0 = mínimo visible, 1 = máximo visible.
// Si min === max (un solo mes visible) no hay forma de ubicar el valor en la escala, así
// que se devuelve el punto medio (ámbar) en vez de forzar un extremo arbitrario.
function linearRatio(value, min, max) {
  return min === max ? 0.5 : (value - min) / (max - min);
}

// Ratio (0..1) para una escala anclada en cero: 0 = rojo (más negativo posible en la fila),
// 0.5 = ámbar (valor 0), 1 = verde (más positivo posible en la fila). A diferencia de una escala
// min/max pura, el 0 real de los datos siempre cae en el punto medio — así el mes "más bajo" de
// una fila toda en positivo no se pinta rojo como si fuera pérdida.
function zeroAnchoredRatio(value, min, max) {
  const floor = Math.min(min, 0);
  const ceil = Math.max(max, 0);
  return value >= 0
    ? ceil > 0 ? 0.5 + 0.5 * Math.min(value / ceil, 1) : 0.5
    : floor < 0 ? 0.5 - 0.5 * Math.min(value / floor, 1) : 0.5;
}

// Heatmap de relleno para Ingresos: rojo (banda baja) -> ámbar -> verde (banda alta), escala
// relativa por fila — ver linearRatio.
function heatmapFill(value, min, max) {
  return FILL_BAND[band(linearRatio(value, min, max))];
}

// Heatmap de relleno anclado en cero, para filas que pueden ser negativas (p.ej. Ganancia).
// Ver zeroAnchoredRatio — rojo solo aparece si el valor es realmente negativo.
function heatmapFillZeroAnchored(value, min, max) {
  return FILL_BAND[band(zeroAnchoredRatio(value, min, max))];
}

// Variante anclada en cero para colorear texto (sin fondo) — usada en % Rentabilidad junto a
// heatmapFillZeroAnchored (p.ej. Ganancia) para que ambas filas coincidan en qué meses pintan rojo.
function heatmapTextZeroAnchored(value, min, max) {
  return RESULT_COLORS[band(zeroAnchoredRatio(value, min, max))];
}

module.exports = { parseMontoARS, montoNoGuardable, pctSobreIngresos, computeDiferenciaCajaAcumulada, computeDiferenciaCajaPorMes, sumarDiferenciaCajaVisible, RESULT_COLORS, heatmapFill, heatmapFillZeroAnchored, heatmapTextZeroAnchored };
