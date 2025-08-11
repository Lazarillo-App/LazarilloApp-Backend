// scripts/migrate-mysql-to-postgres.js
require('dotenv').config();
const mysql = require('mysql2/promise');
const { Pool } = require('pg');

(async () => {
  // ───── 1) Conexiones ────────────────────────────────────────────────────────
  const mysqlConn = await mysql.createConnection({
    host: process.env.MY_HOST,
    user: process.env.MY_USER,
    password: process.env.MY_PASS,
    database: process.env.MY_DB,
    port: Number(process.env.MY_PORT || 3306),
    charset: 'utf8mb4'
  });

  const pgPool = new Pool({
    host: process.env.PGHOST || 'localhost',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'agrupaciones_db',
    port: Number(process.env.PGPORT || 5432),
  });
  const client = await pgPool.connect();

  try {
    console.log('⏳ Leyendo datos desde MySQL…');
    const [agrupaciones] = await mysqlConn.query(
      'SELECT id, nombre FROM agrupaciones'
    );
    const [items] = await mysqlConn.query(`
      SELECT id, agrupacion_id, articulo_id, articulo_nombre, categoria, subrubro, precio
      FROM agrupacion_articulos
    `);

    console.log(`✔️ Agrupaciones: ${agrupaciones.length}`);
    console.log(`✔️ Artículos: ${items.length}`);

    // ───── 2) Transacción y DDL por si faltan tablas ──────────────────────────
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS agrupaciones (
        id BIGINT PRIMARY KEY,
        nombre TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agrupacion_articulos (
        id BIGINT PRIMARY KEY,
        agrupacion_id BIGINT NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
        articulo_id BIGINT NOT NULL,
        articulo_nombre TEXT NOT NULL DEFAULT '',
        categoria TEXT DEFAULT 'Sin categoría',
        subrubro TEXT DEFAULT 'Sin subrubro',
        precio NUMERIC(10,2) NOT NULL DEFAULT 0
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_aa_agrupacion_articulo
      ON agrupacion_articulos (agrupacion_id, articulo_id);
    `);

    // ───── 3) Insert agrupaciones (preserva IDs) ──────────────────────────────
    console.log('⏳ Insertando agrupaciones en Postgres…');
    for (const a of agrupaciones) {
      await client.query(
        `INSERT INTO agrupaciones (id, nombre)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre`,
        [Number(a.id), a.nombre || '']
      );
    }

    // ───── 4) Insert artículos en lotes (rendimiento) ─────────────────────────
    console.log('⏳ Insertando artículos en Postgres (lotes)…');
    const chunk = 1000;
    for (let i = 0; i < items.length; i += chunk) {
      const slice = items.slice(i, i + chunk);
      if (slice.length === 0) continue;

      const values = [];
      const placeholders = slice.map((r, idx) => {
        const base = idx * 7;
        values.push(
          Number(r.id),
          Number(r.agrupacion_id),
          Number(r.articulo_id),
          r.articulo_nombre || '',
          r.categoria || 'Sin categoría',
          r.subrubro || 'Sin subrubro',
          r.precio == null || r.precio === '' ? 0 : Number(r.precio)
        );
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7})`;
      }).join(',');

      await client.query(
        `INSERT INTO agrupacion_articulos
         (id, agrupacion_id, articulo_id, articulo_nombre, categoria, subrubro, precio)
         VALUES ${placeholders}
         ON CONFLICT (id) DO UPDATE SET
           agrupacion_id = EXCLUDED.agrupacion_id,
           articulo_id   = EXCLUDED.articulo_id,
           articulo_nombre = EXCLUDED.articulo_nombre,
           categoria = EXCLUDED.categoria,
           subrubro  = EXCLUDED.subrubro,
           precio    = EXCLUDED.precio`,
        values
      );
    }

    // ───── 5) Ajustar secuencias si existieran ────────────────────────────────
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'agrupaciones_id_seq') THEN
          PERFORM setval('agrupaciones_id_seq', (SELECT COALESCE(MAX(id),1) FROM agrupaciones), true);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'agrupacion_articulos_id_seq') THEN
          PERFORM setval('agrupacion_articulos_id_seq', (SELECT COALESCE(MAX(id),1) FROM agrupacion_articulos), true);
        END IF;
      END$$;
    `);

    await client.query('COMMIT');
    console.log('✅ Migración completa');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Error migrando:', e);
  } finally {
    client.release();
    await mysqlConn.end();
    await pgPool.end();
  }
})();