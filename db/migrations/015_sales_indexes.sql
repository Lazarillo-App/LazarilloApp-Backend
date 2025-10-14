-- 015_sales_indexes.sql
BEGIN;

-- Series diarias baratas (filtro por día en UTC)
CREATE INDEX IF NOT EXISTS ix_app_sales_biz_day
  ON app_sales (business_id, (occurred_at AT TIME ZONE 'UTC')::date);

-- Búsquedas por artículo (ranking/series por item)
CREATE INDEX IF NOT EXISTS ix_app_sales_items_article
  ON app_sales_items (article_id);

-- Acceso por sale_id en items
CREATE INDEX IF NOT EXISTS ix_app_sales_items_sale
  ON app_sales_items (sale_id);

COMMIT;
