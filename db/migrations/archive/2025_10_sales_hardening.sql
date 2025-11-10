--- 2025_10_sales_hardening.sql
-- app_sales: idempotencia por comprobante
ALTER TABLE app_sales
  ADD CONSTRAINT uq_app_sales_biz_ext UNIQUE (business_id, external_id);

-- app_sales: búsquedas por fecha
CREATE INDEX IF NOT EXISTS ix_app_sales_biz_day
  ON app_sales (business_id, (occurred_at AT TIME ZONE 'UTC'));

-- app_sales_items: idempotencia por línea
ALTER TABLE app_sales_items
  ADD CONSTRAINT uq_app_sales_items_sale_pos UNIQUE (sale_id, line_pos);

-- sales_daily: upsert diario
ALTER TABLE sales_daily
  ADD CONSTRAINT uq_sales_daily_biz_day UNIQUE (business_id, day);
