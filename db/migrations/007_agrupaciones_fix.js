// db/007_agrupaciones_fix.js
async function up(pool) {
  const exec = (sql) => pool.query(sql);
  const execSafe = async (sql) => {
    try { await exec(sql); }
    catch (e) {
      if (['42710','42701','23505','42P07'].includes(e.code)) return; // existe / duplicado / etc.
      throw e;
    }
  };

  await execSafe(`
    ALTER TABLE agrupaciones
      ALTER COLUMN articulos TYPE jsonb
      USING (CASE
        WHEN articulos IS NULL OR btrim(articulos::text) = '' THEN '[]'::jsonb
        ELSE articulos::jsonb
      END)
  `);
  await execSafe(`ALTER TABLE agrupaciones ALTER COLUMN articulos SET DEFAULT '[]'::jsonb;`);
  await execSafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_agrupaciones_nombre ON agrupaciones (nombre);`);
}

module.exports = { up };
