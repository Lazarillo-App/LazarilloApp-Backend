-- Agrega objetivo de costo individual por miembro del grupo de gemelos
-- Permite que artículos con la misma receta tengan diferente % objetivo
ALTER TABLE article_link_members
  ADD COLUMN IF NOT EXISTS pct_objetivo NUMERIC(6,2) DEFAULT NULL;

COMMENT ON COLUMN article_link_members.pct_objetivo IS
  'Objetivo de costo % específico para este miembro. NULL = usa el global del negocio.';