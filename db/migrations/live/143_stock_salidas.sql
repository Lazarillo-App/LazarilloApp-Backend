-- 143: Salidas de stock sin venta por artículo y día (Diego 17/11/2026, pendiente #109).
-- Comida de personal, BigBox, publicidad, consumo de empleados/dueños, roturas, errores de
-- delivery… Las unidades vendidas salen del POS (sales_daily_items); esto es lo que salió de la
-- cocina SIN venta, para el filtro Todo / Ventas / Stock y el consumo teórico.
-- Genérica (multi-POS): source = de dónde viene ('maxi' = informe 27 de MaxiRest; otro POS o
-- carga en Lazarillo usan su propio source). transferencia = pase entre puntos de venta
-- («De barra a cancha»): no es consumo, se guarda pero no se suma.
CREATE TABLE IF NOT EXISTS stock_salidas (
  id            BIGSERIAL PRIMARY KEY,
  business_id   BIGINT  NOT NULL,
  branch_id     BIGINT,
  day           DATE    NOT NULL,
  article_id    BIGINT  NOT NULL,
  article_name  TEXT,
  concepto      TEXT    NOT NULL DEFAULT '',
  qty           NUMERIC NOT NULL,
  transferencia BOOLEAN NOT NULL DEFAULT FALSE,
  source        TEXT    NOT NULL DEFAULT 'maxi',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS stock_salidas_biz_day_idx ON stock_salidas (business_id, day);
CREATE INDEX IF NOT EXISTS stock_salidas_biz_art_idx ON stock_salidas (business_id, article_id);
