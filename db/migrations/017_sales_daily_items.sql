BEGIN;
CREATE TABLE IF NOT EXISTS sales_daily_items (
  business_id BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  articulo_id INT    NOT NULL,
  "date"      DATE   NOT NULL,
  qty         NUMERIC(14,3) NOT NULL DEFAULT 0,
  amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, articulo_id, "date")
);

CREATE INDEX IF NOT EXISTS ix_sales_daily_items_day
  ON sales_daily_items ("date");
COMMIT;
 