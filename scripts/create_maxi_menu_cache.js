require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
CREATE TABLE IF NOT EXISTS public.maxi_menu_cache (
  business_id integer NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL,
  PRIMARY KEY (business_id, fetched_at)
);
CREATE INDEX IF NOT EXISTS maxi_menu_cache_biz_ts_idx
  ON public.maxi_menu_cache (business_id, fetched_at DESC);
`;

(async () => {
  try {
    console.log('[DB]', process.env.DATABASE_URL ? 'OK' : 'MISSING DATABASE_URL');
    await pool.query(SQL);
    console.log('maxi_menu_cache creada/actualizada ✅');
  } catch (e) {
    console.error('Error creando tabla maxi_menu_cache:', e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
