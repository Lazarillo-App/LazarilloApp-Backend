-- 041_agrupaciones_add_moved_to.sql
-- Agrega columna para marcar agrupaciones que fueron movidas a otro negocio

ALTER TABLE agrupaciones
  ADD COLUMN IF NOT EXISTS moved_to_business_id BIGINT
    REFERENCES app_businesses(id) ON DELETE SET NULL;

COMMENT ON COLUMN agrupaciones.moved_to_business_id IS
'ID del negocio al que se movió esta agrupación (NULL = no se ha movido)';

CREATE INDEX IF NOT EXISTS idx_agrupaciones_moved_to
  ON agrupaciones(moved_to_business_id)
  WHERE moved_to_business_id IS NOT NULL;