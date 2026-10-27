// db/scripts/check-nombre-interrogacion.js
//
// Diagnóstico de SOLO LECTURA — no modifica nada. Busca en maxi_articles
// todo nombre con un "?" metido ADENTRO de una palabra (no al final de una
// frase ni suelto) — la firma típica de una Ñ que MaxiRest exportó mal.
// Para cada fila, muestra el nombre tal cual está guardado y una propuesta
// de arreglo (? -> Ñ o ñ según mayúscula/minúscula de las letras de al lado),
// para revisar ANTES de correr ningún backfill.
//
// Uso: node db/scripts/check-nombre-interrogacion.js            (todos los negocios)
//      node db/scripts/check-nombre-interrogacion.js 147         (solo ese negocio)
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

// "?" con letra de ambos lados (sin espacio ni otro "?" al lado) — así no
// entran signos de pregunta reales ("¿Hay stock?", "Promo?") que sí tienen
// un espacio o el final del texto de un lado.
const PATRON = /[A-Za-zÁÉÍÓÚáéíóúÑñ]\?[A-Za-zÁÉÍÓÚáéíóúÑñ]/;

function proponer(nombre) {
  return nombre.replace(/([A-Za-zÁÉÍÓÚáéíóúÑñ])\?([A-Za-zÁÉÍÓÚáéíóúÑñ])/g, (m, a, b) => {
    const mayus = a === a.toUpperCase() && a !== a.toLowerCase();
    return a + (mayus ? 'Ñ' : 'ñ') + b;
  });
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

  const sospechosos = rows.filter((r) => PATRON.test(r.nombre));
  const otros = rows.filter((r) => !PATRON.test(r.nombre));

  console.log(`Filas con "?" en el nombre: ${rows.length}`);
  console.log(`  - con pinta de Ñ perdida (? entre letras): ${sospechosos.length}`);
  console.log(`  - otras (? suelto o al final — probablemente un "?" real, NO tocar): ${otros.length}`);

  if (sospechosos.length) {
    console.log('\n=== Propuesta de arreglo (NO aplicado todavía) ===');
    sospechosos.forEach((r) => {
      const nuevo = proponer(r.nombre);
      console.log(`  negocio ${r.business_id} · art #${r.articulo_id}: ${JSON.stringify(r.nombre)} -> ${JSON.stringify(nuevo)}`);
    });
  }
  if (otros.length) {
    console.log('\n=== Con "?" pero NO parece Ñ perdida (se listan para que las revises vos) ===');
    otros.forEach((r) => {
      console.log(`  negocio ${r.business_id} · art #${r.articulo_id}: ${JSON.stringify(r.nombre)}`);
    });
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
