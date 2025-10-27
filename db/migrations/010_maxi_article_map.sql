-- migrations/010_maxi_article_map.sql

CREATE TABLE IF NOT EXISTS public.maxi_article_map (
  business_id  integer NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  articulo_id  integer NOT NULL,
  categoria    text,
  subrubro     text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, articulo_id)
);

CREATE INDEX IF NOT EXISTS maxi_article_map_biz_updated_idx
  ON public.maxi_article_map (business_id, updated_at DESC);
