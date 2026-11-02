// db/scripts/crear-tablas-gestion.js
//
// Crea las tablas gestion_* (integración de lazarillo_gestion) con
// db/migrations/gestion/001_estructura.sql. Solo CREA tablas nuevas: no toca
// ninguna existente ni carga datos (eso es otro script).
//
// DRY-RUN por defecto: corre TODO el SQL dentro de una transacción y al final
// la deshace (ROLLBACK) — así se comprueba contra la base real que cada tabla,
// FK e índice se puede crear, sin dejar nada. Con --aplicar hace COMMIT.
//
// Uso: node db/scripts/crear-tablas-gestion.js [--aplicar]
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../../config/db');

const SQL_FILE = path.join(__dirname, '..', 'migrations', 'gestion', '001_estructura.sql');

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  console.log(aplicar ? 'APLICANDO\n' : 'DRY-RUN (se crea todo y se deshace al final)\n');

  const client = await pool.connect();
  try {
    const { rows: [v] } = await client.query(`SELECT current_setting('server_version_num')::int AS num, version() AS txt`);
    console.log('Postgres:', v.txt.split(',')[0]);
    if (v.num < 150000) throw new Error('Hace falta Postgres 15+ (NULLS NOT DISTINCT / ON DELETE SET NULL (columna)).');

    const { rows: base } = await client.query(
      `SELECT t FROM unnest(ARRAY['organizations','app_businesses','app_branches','app_users']) t
        WHERE to_regclass('public.' || t) IS NULL`
    );
    if (base.length) throw new Error(`Faltan tablas base: ${base.map((r) => r.t).join(', ')}`);

    const { rows: existentes } = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'gestion\\_%' ORDER BY 1`
    );
    if (existentes.length) {
      console.log(`Ya existen ${existentes.length} tablas gestion_*: ${existentes.map((r) => r.tablename).join(', ')}`);
      console.log('No se hace nada (este script es solo para la creación inicial).');
      return;
    }

    const { rows: negocios } = await client.query(
      `SELECT b.id, b.name, b.organization_id, o.name AS organizacion
         FROM app_businesses b LEFT JOIN organizations o ON o.id = b.organization_id
        WHERE b.id IN (147, 204, 210) ORDER BY b.id`
    );
    console.log('\nNegocios a migrar después (y su organización):');
    console.table(negocios);

    await client.query('BEGIN');
    await client.query(fs.readFileSync(SQL_FILE, 'utf8'));

    const { rows: creadas } = await client.query(
      `SELECT c.relname AS tabla,
              (SELECT COUNT(*) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)::int AS columnas,
              (SELECT COUNT(*) FROM pg_index i WHERE i.indrelid = c.oid)::int AS indices,
              (SELECT COUNT(*) FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f')::int AS fks
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'gestion\\_%'
        ORDER BY 1`
    );
    console.log(`\n${creadas.length} tablas gestion_*:`);
    console.table(creadas);

    if (aplicar) {
      await client.query('COMMIT');
      console.log('\nOK — tablas creadas.');
    } else {
      await client.query('ROLLBACK');
      console.log('\nDRY-RUN OK — todo se pudo crear y se deshizo. Agregá --aplicar para crearlas de verdad.');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
