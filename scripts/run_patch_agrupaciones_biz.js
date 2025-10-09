// scripts/run_patch_agrupaciones_biz.js
require('dotenv').config();
const pool = require('../config/db');

(async () => {
  const DEFAULT_BIZ = Number(process.argv[2]);
  if (!Number.isFinite(DEFAULT_BIZ)) {
    console.error('Uso: node scripts/run_patch_agrupaciones_biz.js <business_id_backfill>');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    console.log('> Migración multi-negocio: iniciando...');
    await client.query('BEGIN');

    // 1) Asegurar columna en agrupaciones
    await client.query(`ALTER TABLE agrupaciones ADD COLUMN IF NOT EXISTS business_id INT;`);

    // 2) BACKFILL en agrupaciones (antes del NOT NULL)
    console.log('> Backfill agrupaciones.business_id =', DEFAULT_BIZ, '(solo NULLs)');
    await client.query(
      `UPDATE agrupaciones SET business_id = $1 WHERE business_id IS NULL`,
      [DEFAULT_BIZ]
    );

    // 3) NOT NULL en agrupaciones
    await client.query(`ALTER TABLE agrupaciones ALTER COLUMN business_id SET NOT NULL;`);

    // 4) Índice único por negocio+nombre
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes
           WHERE schemaname='public' AND indexname='ux_agrupaciones_biz_nombre'
        ) THEN
          CREATE UNIQUE INDEX ux_agrupaciones_biz_nombre
            ON agrupaciones (business_id, nombre);
        END IF;
      END $$;
    `);

    // 5) Exclusiones (si existe la tabla)
    const { rows: hasExTable } = await client.query(`
      SELECT 1 FROM information_schema.tables WHERE table_name='agrupacion_exclusiones' LIMIT 1;
    `);
    if (hasExTable.length) {
      await client.query(`ALTER TABLE agrupacion_exclusiones ADD COLUMN IF NOT EXISTS business_id INT;`);

      console.log('> Backfill exclusiones.business_id desde agrupaciones');
      await client.query(`
        UPDATE agrupacion_exclusiones e
           SET business_id = a.business_id
          FROM agrupaciones a
         WHERE e.agrupacion_id = a.id
           AND e.business_id IS NULL;
      `);

      await client.query(`ALTER TABLE agrupacion_exclusiones ALTER COLUMN business_id SET NOT NULL;`);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_indexes
             WHERE schemaname='public' AND indexname='ux_exclusiones_biz_agrup_scope_ref'
          ) THEN
            CREATE UNIQUE INDEX ux_exclusiones_biz_agrup_scope_ref
              ON agrupacion_exclusiones (business_id, agrupacion_id, scope, ref_id);
          END IF;
        END $$;
      `);
    }

    await client.query('COMMIT');
    console.log('> OK: migración aplicada.');
    process.exit(0);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ERROR en migración:', e);
    process.exit(2);
  } finally {
    client.release();
  }
})();

