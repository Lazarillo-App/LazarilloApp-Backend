const { Client } = require('pg');

(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const meta = await c.query(`
    SELECT current_database() AS db,
           current_user      AS usr,
           current_schema()  AS schema,
           current_setting('search_path') AS search_path
  `);
  console.log('META:', meta.rows[0]);

  const r = await c.query(
    "SELECT to_regclass('public.maxi_articles') AS a, to_regclass('public.maxi_sales_daily') AS s"
  );
  console.log('TABLAS:', r.rows[0]);

  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
