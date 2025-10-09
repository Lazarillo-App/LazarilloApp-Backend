-- Cache diario de ventas por artículo y negocio
CREATE TABLE IF NOT EXISTS maxi_sales_daily (
  business_id INT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  articulo_id BIGINT NOT NULL,
  day DATE NOT NULL,
  qty NUMERIC NOT NULL DEFAULT 0,        -- unidades
  amount NUMERIC NOT NULL DEFAULT 0,     -- importe (opcional)
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, articulo_id, day)
);

CREATE INDEX IF NOT EXISTS maxi_sales_daily_biz_day_idx
ON maxi_sales_daily (business_id, day DESC);
