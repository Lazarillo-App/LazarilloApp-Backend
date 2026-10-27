// db/scripts/fix-nombre-interrogacion.js
//
// Backfill del "?" que reemplaza a la Ñ en nombres de artículos synced desde
// MaxiRest (confirmado con check-ene-maxi-cache.js: el "?" ya viene así desde
// la API de MaxiRest, no es un bug de Lazarillo). Arregla SOLO maxi_articles
// .nombre — deja nombre_maxi intacto a propósito: la columna nombre_maxi es
// el espejo de lo último que mandó Maxi, y el UPSERT de sync
// (maxiMenuService.js) protege `nombre` de pisarse en la próxima sincronización
// siempre que sea distinto de nombre_maxi. Como acá nombre pasa a ser distinto
// de nombre_maxi, el arreglo queda protegido para siempre sin tocar nada más.
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

const PATRON = /[A-Za-zÁÉÍÓÚáéíóúÑñ]\?[A-Za-zÁÉÍÓÚáéíóúÑñ]/;

function proponer(nombre) {
  return nombre.replace(/([A-Za-zÁÉÍÓÚáéíóúÑñ])\?([A-Za-zÁÉÍÓÚáéíóúÑñ])/g, (m, a, b) => {
    const mayus = a === a.toUpperCase() && a !== a.toLowerCase();
    return a + (mayus ? 'Ñ' : 'ñ') + b;
  });
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

  const candidatos = rows
    .filter((r) => PATRON.test(r.nombre))
    .map((r) => ({ ...r, nuevo: proponer(r.nombre) }))
    .filter((r) => r.nuevo !== r.nombre);

  if (!candidatos.length) {
    console.log('No hay nada para arreglar.');
    await pool.end();
    return;
  }

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

  if (!aplicar) {
    console.log('\nEsto fue un dry-run. Para aplicar de verdad, agregá --aplicar al final del comando.');
  } else {
    console.log('\nListo — se actualizaron los nombres de arriba.');
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
