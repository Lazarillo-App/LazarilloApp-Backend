// db/scripts/check-nombre-interrogacion.js
//
// Diagnóstico de SOLO LECTURA — no modifica nada. Busca en maxi_articles
// nombres con un "?" metido adentro de una palabra (la firma típica de un
// acento o Ñ que MaxiRest exportó mal) y propone el arreglo SOLO para
// palabras ya verificadas a mano en DICCIONARIO — no adivina letra por
// letra. Un primer intento asumía que todo "?" era una Ñ, y eso rompía
// casos reales (ej. "Energ?tico" es "Energético", con É, no con Ñ) — por
// eso ahora cualquier palabra que no esté en el diccionario se lista aparte
// para revisar a mano, en vez de arriesgar una propuesta.
//
// Uso: node db/scripts/check-nombre-interrogacion.js            (todos los negocios)
//      node db/scripts/check-nombre-interrogacion.js 147         (solo ese negocio)
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

// Palabras confirmadas a mano contra la base real (correr este script antes
// de aplicar nada si aparece una palabra nueva no listada acá).
// Clave: la palabra ROTA en minúscula, con "?" en el lugar de la letra
// perdida. Valor: la palabra correcta en minúscula (se re-aplica mayúscula
// letra por letra al reemplazar, para no romper "CUMPLEA?OS" ni "Pi?a").
const DICCIONARIO = {
  'cumplea?os': 'cumpleaños',
  'cuplea?os': 'cupleaños',       // typo previo (falta una "m") — se preserva, no es parte de este bug
  'bu?uelos': 'buñuelos',
  'pi?a': 'piña',
  'ni?os': 'niños',
  'ma?ana': 'mañana',
  'peque?o': 'pequeño',
  'peque?a': 'pequeña',
  'entra?a': 'entraña',
  'energ?tico': 'energético',
  'energ?tica': 'energética',
};

function aplicarMayusculas(rota, correcta) {
  // letra por letra: si la letra de la rota era mayúscula, la correspondiente
  // en la corrección también lo es — así "CUMPLEA?OS" no se convierte en
  // "cumpleaÑos" ni "Pi?a" en "piÑa". El "?" no tiene mayúscula/minúscula
  // propia, así que justo ahí se mira la letra de al lado para saber el
  // case real (si no, siempre salía en minúscula).
  let out = '';
  for (let i = 0; i < correcta.length; i++) {
    const c = correcta[i];
    let orig = rota[i];
    if (orig === '?') orig = rota[i - 1] || rota[i + 1] || c;
    out += (orig && orig === orig.toUpperCase() && orig !== orig.toLowerCase())
      ? c.toUpperCase() : c;
  }
  return out;
}

function proponer(nombre) {
  let out = nombre;
  let huboCambio = false;
  for (const [rota, correcta] of Object.entries(DICCIONARIO)) {
    const re = new RegExp(rota.replace(/\?/g, '\\?'), 'gi');
    out = out.replace(re, (m) => { huboCambio = true; return aplicarMayusculas(m, correcta); });
  }
  return huboCambio ? out : null;
}

async function main() {
  const arg = process.argv[2];
  const bizId = arg ? Number(arg) : null;

  const { rows } = await pool.query(
    bizId
      ? `SELECT business_id, articulo_id, nombre FROM maxi_articles
          WHERE business_id = $1 AND nombre LIKE '%?%' ORDER BY articulo_id`
      : `SELECT business_id, articulo_id, nombre FROM maxi_articles
          WHERE nombre LIKE '%?%' ORDER BY business_id, articulo_id`,
    bizId ? [bizId] : []
  );

  const conPropuesta = [];
  const sinPropuesta = [];
  for (const r of rows) {
    const nuevo = proponer(r.nombre);
    if (nuevo && nuevo !== r.nombre) conPropuesta.push({ ...r, nuevo });
    else sinPropuesta.push(r);
  }

  console.log(`Filas con "?" en el nombre: ${rows.length}`);
  console.log(`  - con propuesta de arreglo (palabra ya verificada): ${conPropuesta.length}`);
  console.log(`  - SIN propuesta (palabra no reconocida o "?" suelto — revisar a mano): ${sinPropuesta.length}`);

  if (conPropuesta.length) {
    console.log('\n=== Propuesta de arreglo (NO aplicado todavía) ===');
    conPropuesta.forEach((r) => {
      console.log(`  negocio ${r.business_id} · art #${r.articulo_id}: ${JSON.stringify(r.nombre)} -> ${JSON.stringify(r.nuevo)}`);
    });
  }
  if (sinPropuesta.length) {
    console.log('\n=== SIN propuesta automática — revisar y corregir a mano ===');
    sinPropuesta.forEach((r) => {
      console.log(`  negocio ${r.business_id} · art #${r.articulo_id}: ${JSON.stringify(r.nombre)}`);
    });
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
