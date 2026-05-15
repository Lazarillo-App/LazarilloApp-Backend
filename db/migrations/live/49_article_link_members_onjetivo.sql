-- Agrega pct_objetivo a article_link_members
-- Permite que cada artículo gemelo tenga su propio objetivo de costo
ALTER TABLE article_link_members
  ADD COLUMN IF NOT EXISTS pct_objetivo numeric(5,2) DEFAULT NULL;

-- Agrega nombre en el endpoint via join con maxi_articles (no columna, se resuelve en query)