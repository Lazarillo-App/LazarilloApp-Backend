// services/gestion/decimal-canonico.js
//
// Reemplazo de `new Prisma.Decimal(x).toString()` (decimal.js), que gestion usa
// para canonizar importes antes de hashearlos (compra-identity.js). Tiene que dar
// EXACTAMENTE el mismo string: entra en el rowId de las compras, y un rowId
// distinto para el mismo dato duplicaría la compra en vez de actualizarla.
// Verificado contra decimal.js 10.4.3 (ver decimal-canonico.test.js).
//
// Reglas de decimal.js#toString con la configuración por defecto de Prisma:
// - sin ceros a la izquierda ni a la derecha ("1500.50" → "1500.5", "007" → "7")
// - notación exponencial si el exponente es <= -7 o >= 21 ("1e-7", "1e+21")
// - el cero siempre es "0" (también "-0", "0.000")
// Devuelve null si el texto no es un número decimal (el llamador decide qué hacer).
'use strict';

const TO_EXP_NEG = -7;
const TO_EXP_POS = 21;

function decimalCanonico(raw) {
  const m = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(raw));
  if (!m || (!m[2] && !m[3])) return null;
  const negativo = m[1] === '-';
  const entera = m[2] || '';
  const fraccion = m[3] || '';
  const exp10 = m[4] ? Number(m[4]) : 0;

  // Dígitos significativos y exponente del primer dígito (notación d.ddd × 10^e)
  let digitos = (entera + fraccion).replace(/^0+/, '');
  if (!digitos) return '0';
  const cerosQuitados = (entera + fraccion).length - digitos.length;
  const e = entera.length - cerosQuitados - 1 + exp10;
  digitos = digitos.replace(/0+$/, '');

  let s;
  if (e <= TO_EXP_NEG || e >= TO_EXP_POS) {
    s = digitos[0] + (digitos.length > 1 ? '.' + digitos.slice(1) : '') + 'e' + (e < 0 ? '' : '+') + e;
  } else if (e < 0) {
    s = '0.' + '0'.repeat(-e - 1) + digitos;
  } else if (digitos.length > e + 1) {
    s = digitos.slice(0, e + 1) + '.' + digitos.slice(e + 1);
  } else {
    s = digitos + '0'.repeat(e + 1 - digitos.length);
  }
  return negativo ? '-' + s : s;
}

module.exports = { decimalCanonico };
