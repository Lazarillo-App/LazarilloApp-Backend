// scripts/migrate-mysql-to-postgres.js
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });
const mysql = require('mysql2/promise');
const { Pool } = require('pg');

async function createSchema(pg) {
  await pg.query(`
    -- ========== Tablas base ==========
    CREATE TABLE IF NOT EXISTS agrupaciones (
      id BIGSERIAL PRIMARY KEY,
      nombre TEXT NOT NULL
      -- columnas de timestamps se agregan abajo con ALTER TABLE para cubrir el caso de tabla preexistente
    );

    -- Asegurar timestamps en agrupaciones aunque la tabla ya exista
    ALTER TABLE agrupaciones
      ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS agrupacion_articulos (
      id BIGSERIAL PRIMARY KEY,
      agrupacion_id BIGINT NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
      articulo_id BIGINT NOT NULL,
      articulo_nombre TEXT NOT NULL,
      categoria TEXT DEFAULT 'Sin categoría',
      subrubro TEXT DEFAULT 'Sin subrubro',
      precio NUMERIC(10,2) NOT NULL DEFAULT 0
    );

    -- ========== Índices ==========
    CREATE INDEX IF NOT EXISTS idx_aa_agrupacion_id ON agrupacion_articulos (agrupacion_id);
    CREATE INDEX IF NOT EXISTS idx_aa_articulo_id   ON agrupacion_articulos (articulo_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_aa_agrupacion_articulo ON agrupacion_articulos (agrupacion_id, articulo_id);

    -- ========== Trigger updated_at ==========
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS agrupaciones_set_updated_at ON agrupaciones;
    CREATE TRIGGER agrupaciones_set_updated_at
    BEFORE UPDATE ON agrupaciones
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

(async () => {
  const start = Date.now();
  try {
    console.log('⏳ Conectando a MySQL origen...');
    const mysqlConn = await mysql.createConnection({
      host: process.env.MY_HOST,
      user: process.env.MY_USER,
      password: process.env.MY_PASS,
      database: process.env.MY_DB,
      port: Number(process.env.MY_PORT) || 3306
    });

    console.log('⏳ Conectando a Postgres destino...');
    const pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Si no usás SSL en local, podés quitar esto o hacerlo condicional
      ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    });

    console.log('🔧 Verificando/creando esquema en Postgres…');
    await createSchema(pgPool);

    console.log('📦 Leyendo datos de MySQL...');
    const [agrupaciones] = await mysqlConn.execute('SELECT id, nombre FROM agrupaciones');
    const [articulos] = await mysqlConn.execute(`
      SELECT 
        agrupacion_id,
        articulo_id,
        COALESCE(articulo_nombre, '') AS articulo_nombre,
        COALESCE(categoria, 'Sin categoría') AS categoria,
        COALESCE(subrubro, 'Sin subrubro') AS subrubro,
        COALESCE(precio, 0) AS precio
      FROM agrupacion_articulos
    `);

    console.log(`➡ Insertando ${agrupaciones.length} agrupaciones y ${articulos.length} artículos...`);

    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');

      // Limpiar destino para migración idempotente
      await client.query('TRUNCATE agrupacion_articulos RESTART IDENTITY CASCADE');
      await client.query('TRUNCATE agrupaciones RESTART IDENTITY CASCADE');

      // Insert agrupaciones (conservar IDs)
      if (agrupaciones.length) {
        const values = [];
        const placeholders = agrupaciones.map((a, i) => {
          values.push(a.id, a.nombre);
          const b = i * 2;
          return `($${b + 1}, $${b + 2})`;
        }).join(',');
        await client.query(`INSERT INTO agrupaciones (id, nombre) VALUES ${placeholders}`, values);

        // Opcional: actualizar timestamps si querés dejarlos en NOW()
        await client.query(`UPDATE agrupaciones SET created_at = NOW(), updated_at = NOW()`);
      }

      // Insert articulos en lotes
      const cols = ['agrupacion_id','articulo_id','articulo_nombre','categoria','subrubro','precio'];
      const lotes = chunk(articulos, 1000);
      for (const lote of lotes) {
        if (!lote.length) continue;
        const vals = [];
        const ph = lote.map((row, i) => {
          vals.push(
            row.agrupacion_id,
            row.articulo_id,
            row.articulo_nombre || '',
            row.categoria || 'Sin categoría',
            row.subrubro || 'Sin subrubro',
            row.precio ?? 0
          );
          const base = i * cols.length;
          return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6})`;
        }).join(',');
        await client.query(
          `INSERT INTO agrupacion_articulos (${cols.join(',')}) VALUES ${ph}`,
          vals
        );
      }

      await client.query('COMMIT');
      console.log(`✅ Migración completada en ${(Date.now()-start)/1000}s`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
      await mysqlConn.end();
      await pgPool.end();
    }
  } catch (err) {
    console.error('❌ Error migrando:', err);
    process.exit(1);
  }
})();
