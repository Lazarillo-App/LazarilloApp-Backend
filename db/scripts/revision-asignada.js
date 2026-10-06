// db/scripts/revision-asignada.js
// Permite asignar una revisión a un miembro del staff específico. Idempotente.
// Correr una vez en Render Shell:  node db/scripts/revision-asignada.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  await pool.query(`ALTER TABLE receta_proposals ADD COLUMN IF NOT EXISTS asignado_a_user_id INT REFERENCES app_users(id)`);
  console.log('OK — receta_proposals admite asignado_a_user_id.');
  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
