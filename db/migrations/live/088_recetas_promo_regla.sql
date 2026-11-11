-- Regla de precio de una promoción (Diego 11/11/2026). Una promo es una receta con artículos como
-- ingredientes; su precio sale de una de tres reglas:
--   'margen'  → costo ÷ objetivo (lo de siempre; objetivo y precio en article_price_config)
--   'off'     → venta sin promo × (1 − promo_off_pct/100); no se edita a mano
--   'nxm'     → venta sin promo × promo_pagas / promo_llevas (llevás N, pagás M); no se edita a mano
-- NULL = 'margen'. Las promos 'off' y 'nxm' quedan atadas al precio de sus artículos.
ALTER TABLE recetas ADD COLUMN IF NOT EXISTS promo_regla   TEXT;
ALTER TABLE recetas ADD COLUMN IF NOT EXISTS promo_off_pct NUMERIC;
ALTER TABLE recetas ADD COLUMN IF NOT EXISTS promo_llevas  INTEGER;
ALTER TABLE recetas ADD COLUMN IF NOT EXISTS promo_pagas   INTEGER;
