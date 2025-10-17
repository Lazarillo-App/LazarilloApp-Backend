CREATE TABLE IF NOT EXISTS public.maxi_menu_cache (
  business_id  integer NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  payload      jsonb   NOT NULL,
  hash         text    NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, hash)
);
CREATE INDEX IF NOT EXISTS maxi_menu_cache_biz_updated_idx
  ON public.maxi_menu_cache (business_id, updated_at DESC);
