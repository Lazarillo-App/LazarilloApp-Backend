-- 006_maxi_sales_unique.sql

-- Crea la tabla si no existía
CREATE TABLE IF NOT EXISTS public.maxi_sales_daily (
  business_id  integer    NOT NULL,
  articulo_id  integer    NOT NULL,
  day          date       NOT NULL,
  qty          numeric    NOT NULL DEFAULT 0,
  amount       numeric    NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Si ya existían duplicados, BORRA duplicados dejando el último updated_at
WITH dups AS (
  SELECT business_id, articulo_id, day,
         ROW_NUMBER() OVER (PARTITION BY business_id, articulo_id, day ORDER BY updated_at DESC) AS rn
  FROM public.maxi_sales_daily
)
DELETE FROM public.maxi_sales_daily m
USING dups
WHERE m.business_id = dups.business_id
  AND m.articulo_id = dups.articulo_id
  AND m.day = dups.day
  AND dups.rn > 1;

-- Agrega constraint única (ignora error si ya existe)
DO $$ BEGIN
  ALTER TABLE public.maxi_sales_daily
  ADD CONSTRAINT maxi_sales_daily_uq UNIQUE (business_id, articulo_id, day);
EXCEPTION WHEN duplicate_table THEN
  -- nada
WHEN duplicate_object THEN
  -- nada
END $$;

-- Un índice de soporte (opcional, si hacés queries por business y rango)
CREATE INDEX IF NOT EXISTS maxi_sales_daily_biz_day_idx
  ON public.maxi_sales_daily (business_id, day);
