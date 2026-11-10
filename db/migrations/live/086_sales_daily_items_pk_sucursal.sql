-- 086 · Ventas por sucursal en Recetas (10/11/2026). sales_daily_items tenía PK (business_id, day,
-- article_id), sin sucursal: cuando FC RAMOS y FC SAN JUSTO (negocio 204) venden el mismo artículo
-- el mismo día, la pasada de Recetas fallaba con "duplicate key ... sales_daily_items_pkey" y el 204
-- quedó con ventas hasta el 29/10. Lo mismo que db/scripts/migrar-claves-sucursales.js (que la 022
-- deshacía en cada arranque): la PK pasa a (id) y el único queda en idx_sales_daily_items_unique
-- (business_id, day, article_id, COALESCE(branch_id, 0)). No toca filas. Idempotente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_daily_items_unique
  ON sales_daily_items (business_id, day, article_id, COALESCE(branch_id, 0::bigint));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'sales_daily_items'::regclass AND contype = 'p'
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE sales_daily_items DROP CONSTRAINT sales_daily_items_pkey;
    ALTER TABLE sales_daily_items ADD CONSTRAINT sales_daily_items_pkey PRIMARY KEY (id);
  END IF;
END $$;
