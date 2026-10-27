// db/scripts/fix-nombre-interrogacion.js
//
// Backfill del "?" que reemplaza letras con acento/Ñ en nombres de artículos
// synced desde MaxiRest (confirmado con check-ene-maxi-cache.js: el "?" ya
// viene así desde la API de MaxiRest, no es un bug de Lazarillo). Arregla
// SOLO maxi_articles.nombre — deja nombre_maxi intacto a propósito: la
// columna nombre_maxi es el espejo de lo último que mandó Maxi, y el UPSERT
// de sync (maxiMenuService.js) protege `nombre` de pisarse en la próxima
// sincronización siempre que sea distinto de nombre_maxi. Como acá nombre
// pasa a ser distinto de nombre_maxi, el arreglo queda protegido para
// siempre sin tocar nada más.
//
// Usa el mismo DICCIONARIO verificado a mano que check-nombre-interrogacion.js
// — NO adivina letra por letra (un primer intento asumía que "?" siempre
// era Ñ, y eso hubiera roto "Energético" convirtiéndolo en "Energñtico").
// Cualquier "?" que no matchee una palabra conocida queda SIN TOCAR.
//
// Por default corre en modo DRY-RUN (solo muestra qué cambiaría, no escribe
// nada). Para aplicar de verdad: agregar --aplicar al final.
//
// Uso: node db/scripts/fix-nombre-interrogacion.js 147              (dry-run, un negocio)
//      node db/scripts/fix-nombre-interrogacion.js 147 --aplicar    (aplica, un negocio)
//      node db/scripts/fix-nombre-interrogacion.js --aplicar        (aplica, TODOS los negocios)
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

const DICCIONARIO = {
  'cumplea?os': 'cumpleaños',
  'cuplea?os': 'cupleaños',
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
  let out = '';
  for (let i = 0; i < correcta.length; i++) {
    const c = correcta[i];
    // El "?" no tiene mayúscula/minúscula propia, así que ahí se mira la
    // letra de al lado para saber el case real (si no, siempre salía ñ
    // en minúscula aunque el resto de la palabra fuera mayúscula).
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
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const bizArg = args.find((a) => a !== '--aplicar');
  const bizId = bizArg ? Number(bizArg) : null;

  const { rows } = await pool.query(
    bizId
      ? `SELECT business_id, articulo_id, nombre FROM maxi_articles
          WHERE business_id = $1 AND nombre LIKE '%?%' ORDER BY articulo_id`
      : `SELECT business_id, articulo_id, nombre FROM maxi_articles
          WHERE nombre LIKE '%?%' ORDER BY business_id, articulo_id`,
    bizId ? [bizId] : []
  );

  const candidatos = [];
  const sinReconocer = [];
  for (const r of rows) {
    const nuevo = proponer(r.nombre);
    if (nuevo && nuevo !== r.nombre) candidatos.push({ ...r, nuevo });
    else sinReconocer.push(r);
  }

  if (!candidatos.length) {
    console.log('No hay nada reconocido para arreglar.');
  } else {
    console.log(`${aplicar ? 'APLICANDO' : 'DRY-RUN (no se escribe nada)'} — ${candidatos.length} fila(s):\n`);
    for (const r of candidatos) {
      console.log(`  negocio ${r.business_id} · art #${r.articulo_id}: ${JSON.stringify(r.nombre)} -> ${JSON.stringify(r.nuevo)}`);
      if (aplicar) {
        await pool.query(
          `UPDATE maxi_articles SET nombre = $1 WHERE business_id = $2 AND articulo_id = $3`,
          [r.nuevo, r.business_id, r.articulo_id]
        );
      }
    }
    console.log(aplicar
      ? '\nListo — se actualizaron los nombres de arriba.'
      : '\nEsto fue un dry-run. Para aplicar de verdad, agregá --aplicar al final del comando.');
  }

  if (sinReconocer.length) {
    console.log(`\n${sinReconocer.length} fila(s) con "?" NO reconocidas — no se tocaron, revisar a mano:`);
    sinReconocer.forEach((r) => {
      console.log(`  negocio ${r.business_id} · art #${r.articulo_id}: ${JSON.stringify(r.nombre)}`);
    });
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
