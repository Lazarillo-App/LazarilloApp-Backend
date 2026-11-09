// utils/passwordPolicy.js
// Regla única para toda contraseña que se elige o se cambia (decisión de la usuaria, 2026-11-09):
// al menos 10 caracteres, 1 mayúscula y 1 número. Las contraseñas existentes siguen valiendo: la
// regla corre solo al crear o cambiar una. La misma regla vive en el Front (src/utils/password.js).
'use strict';

const MIN_LARGO = 10;

/** Devuelve null si la contraseña cumple, o qué le falta: 'corta' | 'sin_mayuscula' | 'sin_numero'. */
function problemaPassword(password) {
  const p = String(password ?? '');
  if (p.length < MIN_LARGO) return 'corta';
  if (!/\p{Lu}/u.test(p)) return 'sin_mayuscula';
  if (!/\d/.test(p)) return 'sin_numero';
  return null;
}

const MENSAJE = 'La contraseña tiene que tener al menos 10 caracteres, una mayúscula y un número.';

/** Responde 400 (y devuelve true) si no cumple; si cumple devuelve false y no responde nada. */
function rechazarPasswordDebil(res, password) {
  const problema = problemaPassword(password);
  if (!problema) return false;
  res.status(400).json({ ok: false, error: 'password_weak', detalle: problema, message: MENSAJE });
  return true;
}

module.exports = { MIN_LARGO, problemaPassword, rechazarPasswordDebil, MENSAJE };
