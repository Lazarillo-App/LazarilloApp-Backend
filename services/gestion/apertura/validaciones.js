// Portado de lazarillo_gestion/lib/apertura/validaciones.ts (TypeScript → JavaScript, misma lógica).
'use strict';



// Tolerancia de redondeo — reparto en 3 con decimales periódicos (33.33 x3 =
// 99.99, no 100) es válido en la práctica (spec no exige más de 2 decimales
// por destino). No confundir con la corrección exacta a nivel importe, que
// calcularDistribuciones ya garantiza vía "el último se lleva el resto".
const TOLERANCIA = 0.01;

function validarSumaPorcentajes(destinos) {
  if (destinos.length === 0) return false;
  const suma = destinos.reduce((acc, d) => acc + d.porcentaje, 0);
  return Math.abs(suma - 100) <= TOLERANCIA;
}

function aIntervalo(r) {
  if (r.modo === "historico") {
    return { desde: -Infinity, desdeInclusivo: true, hasta: Infinity, hastaInclusivo: true };
  }
  const desde = r.modo === "desde_atras" ? -Infinity : r.fechaDesde.getTime();
  const hasta = r.modo === "desde_adelante" ? Infinity : r.fechaHasta.getTime();
  return {
    desde,
    desdeInclusivo: r.modo === "desde_atras" ? true : r.extremosInclusivos,
    hasta,
    hastaInclusivo: r.modo === "desde_adelante" ? true : r.extremosInclusivos,
  };
}

function seSuperponen(a, b) {
  const aTerminaAntesDeB = a.hasta < b.desde || (a.hasta === b.desde && !(a.hastaInclusivo && b.desdeInclusivo));
  const bTerminaAntesDeA = b.hasta < a.desde || (b.hasta === a.desde && !(b.hastaInclusivo && a.desdeInclusivo));
  return !aTerminaAntesDeB && !bTerminaAntesDeA;
}

// Devuelve el id de la primera regla existente que se superpone con `nueva`,
// o null si no hay conflicto. `existentes` debe venir pre-filtrado por el
// caller (mismo entidadId + estado 'activa' — ver route handler, Task 7).
function encontrarSuperposicion(
  nueva,
  existentes
) {
  const intNueva = aIntervalo(nueva);
  for (const existente of existentes) {
    if (seSuperponen(intNueva, aIntervalo(existente))) return existente.id;
  }
  return null;
}

// Dos destinos compiten por la misma plata cuando son del mismo local y
// además: apuntan al mismo punto de venta específico, o al menos uno de los
// dos es "todo el local" (puntoDeVentaId null) — "todo el local" ya incluye
// la plata de cualquier punto de venta específico de ese local, así que no
// pueden coexistir como dos destinos separados sin duplicar el reparto.
function destinosSuperpuestos(a, b) {
  if (a.localId == null || b.localId == null || a.localId !== b.localId) return false;
  if (a.puntoDeVentaId === null || b.puntoDeVentaId === null) return true;
  return a.puntoDeVentaId === b.puntoDeVentaId;
}

// Alias semántico: dos ORÍGENES compiten por la misma plata bajo la misma
// regla que dos destinos — mismo local y (mismo PDV puntual, o al menos uno
// es "todo el local"). Se reexpone con nombre propio para que los callers de
// superposición de reglas (motor.verificarSinSuperposicion) y el indicador
// del dashboard lean la intención sin depender del nombre "destino".
function origenesSuperpuestos(a, b) {
  return destinosSuperpuestos(a, b);
}

// ¿Una compra ubicada en `ubicacion` cae bajo el `origen` de una regla?
// origen con puntoDeVentaId → solo ese PDV; origen solo con localId → todo el
// local. Una compra sin localId (dato de ubicación ausente) no la alcanza
// ninguna regla — no hay forma de saber su origen (ver spec sección 4.1).
function origenAlcanza(
  origen,
  ubicacion
) {
  if (origen.puntoDeVentaId != null) return ubicacion.puntoDeVentaId === origen.puntoDeVentaId;
  return ubicacion.localId != null && ubicacion.localId === origen.localId;
}

// Devuelve el índice de la primera fila que se superpone con una fila
// anterior (ver destinosSuperpuestos), o null si no hay ninguna superposición.
function encontrarDestinoDuplicado(destinos) {
  for (let i = 0; i < destinos.length; i++) {
    if (destinos[i].localId == null) continue; // fila todavía sin completar, no es un duplicado real
    for (let j = 0; j < i; j++) {
      if (destinosSuperpuestos(destinos[i], destinos[j])) return i;
    }
  }
  return null;
}

module.exports = { validarSumaPorcentajes, encontrarSuperposicion, destinosSuperpuestos, origenesSuperpuestos, origenAlcanza, encontrarDestinoDuplicado };
