// Portado de lazarillo_gestion/lib/gastos-varios/periodo.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Gastos Varios cargados en Lazarillo (Etapa 4). Un gasto vario se guarda como un
// Ticket del proveedor "Gastos Varios" (código GV) con número interno 9999-NNNNNNNN:
// así entra a la vista Económica por su fecha, a la Financiera por su pago, y si queda
// sin pagar aparece en Impagas y en la cta cte de Gastos Varios (Diego, 27/10/2026).
// Se elige primero el PERÍODO (mes) y la fecha va al 15 de ese mes salvo que se cambie.

const GV_CODIGO = "GV";
const GV_NOMBRE = "Gastos Varios";
const GV_PREFIJO = "9999";
const GV_DIA = 15;

const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const p2 = (n) => String(n).padStart(2, "0");

/** "2026-10" → "2026-10-15". */
function fechaDelPeriodo(periodo) {
  return `${periodo}-${p2(GV_DIA)}`;
}

/** "2026-10-27" → "2026-10". */
function periodoDe(fechaISO) {
  return fechaISO.slice(0, 7);
}

/** Corre el período n meses (‹ ›). */
function moverPeriodo(periodo, n) {
  const [y, m] = periodo.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${p2((t % 12) + 1)}`;
}

/** "2026-10" → "Octubre 2026". */
function nombrePeriodo(periodo) {
  const [y, m] = periodo.split("-").map(Number);
  return `${MESES[m - 1] ?? "?"} ${y}`;
}

/** Siguiente número interno a partir del mayor comprobante GV ("Z9999" + 8 dígitos). */
function siguienteNumeroGV(mayor) {
  const n = mayor && /^Z\d{4}\d{8}$/.test(mayor) ? Number(mayor.slice(5)) : 0;
  return String(n + 1).padStart(8, "0");
}

module.exports = { GV_CODIGO, GV_NOMBRE, GV_PREFIJO, GV_DIA, fechaDelPeriodo, periodoDe, moverPeriodo, nombrePeriodo, siguienteNumeroGV };
