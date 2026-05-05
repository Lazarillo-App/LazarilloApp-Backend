-- 046_insumo_lists.sql
-- Agrega scope a article_lists para separar listas de artículos de listas de insumos
-- y crea la tabla insumo_list_items para los items de insumos

-- Columna scope en article_lists (default 'article' para no romper existentes)
ALTER TABLE article_lists
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'article';

-- Tabla de items de listas de insumos
CREATE TABLE IF NOT EXISTS insumo_list_items (
  id         bigserial    PRIMARY KEY,
  list_id    bigint       NOT NULL REFERENCES article_lists(id) ON DELETE CASCADE,
  insumo_id  integer      NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  added_at   timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (list_id, insumo_id)
);

CREATE INDEX IF NOT EXISTS insumo_list_items_list_idx ON insumo_list_items (list_id);
CREATE INDEX IF NOT EXISTS insumo_list_items_insumo_idx ON insumo_list_items (insumo_id);