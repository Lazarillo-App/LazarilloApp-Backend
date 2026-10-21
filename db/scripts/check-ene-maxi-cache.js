// db/scripts/check-ene-maxi-cache.js
//
// Diagnóstico de SOLO LECTURA — no modifica nada. Busca en el último
// snapshot crudo de maxi_menu_cache (lo que la API de MaxiRest devolvió,
// antes de que Lazarillo lo toque) los artículos de "CUMPLEAÑOS" para ver
// si el "?" que reemplaza a la Ñ ya viene así desde MaxiRest, o si se
// introduce después, del lado de Lazarillo.
//
// Uso: node db/scripts/check-ene-maxi-cache.js <business_id>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const bizId = Number(process.argv[2]);
  if (!Number.isFinite(bizId) || bizId <= 0) {
    console.error('Uso: node db/scripts/check-ene-maxi-cache.js <business_id>');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT updated_at, payload FROM maxi_menu_cache
      WHERE business_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [bizId]
  );
  if (!rows.length) {
    console.log('No hay cache para ese negocio.');
    await pool.end();
    return;
  }

  const { updated_at, payload } = rows[0];
  console.log(`Cache de ${updated_at.toISOString()}`);

  const content = Array.isArray(payload) ? payload : (payload?.content || []);
  const encontrados = [];

  function recorrer(nodo) {
    if (!nodo) return;
    const nombre = nodo.nombre ?? nodo.descripcion ?? '';
    if (typeof nombre === 'string' && /cumplea/i.test(nombre)) {
      encontrados.push({ codigo: nodo.codigo ?? nodo.cod ?? nodo.id, nombre });
    }
    (nodo.articulos || []).forEach(recorrer);
    (nodo.subrubros || []).forEach(recorrer);
  }
  content.forEach(recorrer);

  console.log(`\nEncontrados ${encontrados.length} con "cumplea" en el nombre:`);
  encontrados.slice(0, 15).forEach((e) => {
    console.log(`  ${e.codigo}: ${JSON.stringify(e.nombre)}`);
  });

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
