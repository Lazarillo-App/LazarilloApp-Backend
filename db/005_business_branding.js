// db/005_business_branding.js
module.exports.up = async (pool) => {
  const q = (s, p=[]) => pool.query(s, p);
  const safe = async (s) => { try { await q(s); } catch (e) {
    if (['42710','42701','23505','42P07'].includes(e.code)) return; throw e;
  }};

  await safe(`ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS slug TEXT;`);
  await safe(`ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS props JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  await safe(`ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS brand_logo_url TEXT;`);
  await safe(`ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS brand_font TEXT;`);

  await safe(`CREATE UNIQUE INDEX IF NOT EXISTS app_businesses_slug_key ON app_businesses(slug);`);
  await safe(`CREATE INDEX IF NOT EXISTS app_businesses_props_gin ON app_businesses USING gin (props);`);
};
