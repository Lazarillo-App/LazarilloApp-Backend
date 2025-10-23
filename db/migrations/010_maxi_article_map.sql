-- migrations/010_maxi_article_map.sql
CREATE TABLE IF NOT EXISTS public.maxi_article_map (
  business_id       integer NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  article_id        integer NOT NULL,
  rubro_id          integer,
  rubro_nombre      text,
  subrubro_id       integer,
  subrubro_nombre   text,
  node_type         text,
  nombre            text,
  precio            numeric(14,2),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, article_id)
);

CREATE INDEX IF NOT EXISTS ix_maxi_article_map_biz_rubro
  ON public.maxi_article_map (business_id, rubro_id, subrubro_id);
