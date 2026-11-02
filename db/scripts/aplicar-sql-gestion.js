// db/scripts/aplicar-sql-gestion.js
//
// Aplica un archivo de db/migrations/gestion/ (vistas, índices o cambios de las
// tablas gestion_* del port de lazarillo_gestion).
//
// DRY-RUN por defecto: ejecuta el SQL dentro de una transacción y la deshace
// (ROLLBACK), así se comprueba contra la base real que se puede aplicar sin dejar
// nada. Con --aplicar hace COMMIT.
//
// Uso: node db/scripts/aplicar-sql-gestion.js <archivo.sql> [--aplicar]
//   ej: node db/scripts/aplicar-sql-gestion.js 002_v_compras_distribuidas.sql
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../../config/db');

async function main() {
  const archivo = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const aplicar = process.argv.includes('--aplicar');
  if (!archivo) {
    console.log('Uso: node db/scripts/aplicar-sql-gestion.js <archivo.sql> [--aplicar]');
    console.log('Archivos:', fs.readdirSync(path.join(__dirname, '..', 'migrations', 'gestion')).join(', '));
    process.exit(1);
  }
  const ruta = path.join(__dirname, '..', 'migrations', 'gestion', path.basename(archivo));
  const sql = fs.readFileSync(ruta, 'utf8');
  console.log(`${aplicar ? 'APLICANDO' : 'DRY-RUN (se ejecuta y se deshace)'}: ${path.basename(ruta)}\n`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    const { rows: vistas } = await client.query(
      `SELECT table_name FROM information_schema.views WHERE table_schema = 'public' AND table_name LIKE 'gestion\\_%' ORDER BY 1`
    );
    console.log('Vistas gestion_* después de aplicar:', vistas.map((v) => v.table_name).join(', ') || '(ninguna)');
    if (aplicar) {
      await client.query('COMMIT');
      console.log('\nOK — aplicado.');
    } else {
      await client.query('ROLLBACK');
      console.log('\nDRY-RUN OK — se pudo aplicar y se deshizo. Agregá --aplicar para dejarlo.');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch((err) => console.error('rollback:', err.message));
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
