-- 014_sales.sql
BEGIN;

-- app_sales: comprobantes de venta (1 row por ticket/factura)
CREATE TABLE IF NOT EXISTS app_sales (
  id            BIGSERIAL PRIMARY KEY,
  business_id   BIGINT      NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  external_id   TEXT        NOT NULL,  -- id de Maxi/tercero (estable)
  occurred_at   TIMESTAMPTZ NOT NULL,  -- fecha/hora efectiva de la venta (UTC)
  total         NUMERIC(14,2) NOT NULL DEFAULT 0,
  props         JSONB        NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Unicidad por negocio + id externo (idempotencia)
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_sales_business_external
  ON app_sales (business_id, external_id);

-- Búsquedas por rango/orden
CREATE INDEX IF NOT EXISTS ix_app_sales_business_occurred_at
  ON app_sales (business_id, occurred_at DESC);

-- app_sales_items: líneas de la venta (opcional)
CREATE TABLE IF NOT EXISTS app_sales_items (
  id            BIGSERIAL PRIMARY KEY,
  sale_id       BIGINT      NOT NULL REFERENCES app_sales(id) ON DELETE CASCADE,
  line_pos      INTEGER     NOT NULL,                -- posición de línea
  article_id    BIGINT      NULL,                    -- si hay mapeo a nuestro artículo
  sku           TEXT        NULL,                    -- sku/código de Maxi
  name          TEXT        NULL,                    -- nombre descriptivo
  quantity      NUMERIC(14,3) NOT NULL DEFAULT 0,
  unit_price    NUMERIC(14,4) NOT NULL DEFAULT 0,
  total         NUMERIC(14,2) NOT NULL DEFAULT 0,
  props         JSONB        NOT NULL DEFAULT '{}'
);

-- Evita duplicar líneas si re-procesamos el mismo ticket
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_sales_items_sale_line
  ON app_sales_items (sale_id, line_pos);

-- Agregados diarios (series)
CREATE TABLE IF NOT EXISTS sales_daily (
  business_id BIGINT     NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  day         DATE       NOT NULL,
  total       NUMERIC(14,2) NOT NULL DEFAULT 0,
  tx_count    INTEGER       NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, day)
);

-- Aseguramos columna props en app_businesses (si no la tenías)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'app_businesses' AND column_name = 'props'
  ) THEN
    ALTER TABLE app_businesses ADD COLUMN props JSONB NOT NULL DEFAULT '{}';
  END IF;
END
$$;

-- Trigger de updated_at en app_sales
CREATE OR REPLACE FUNCTION trg_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_touch_app_sales ON app_sales;
CREATE TRIGGER tg_touch_app_sales
BEFORE UPDATE ON app_sales
FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at();

COMMIT;

