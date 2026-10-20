// db/scripts/add-receta-almacenamiento.js
//
// Agrega 2 columnas nuevas a `recetas` para "Notas e imagen de la receta":
// método de almacenamiento en freezer y en heladera (texto libre, igual
// criterio que metodo_coccion).
//
// Uso: node db/scripts/add-receta-almacenamiento.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  await pool.query(`
    ALTER TABLE recetas ADD COLUMN IF NOT EXISTS almacenamiento_freezer TEXT;
    ALTER TABLE recetas ADD COLUMN IF NOT EXISTS almacenamiento_heladera TEXT;
  `);
  console.log('✅ Columnas de almacenamiento agregadas a recetas');

  await pool.end();
  console.log('Listo.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
