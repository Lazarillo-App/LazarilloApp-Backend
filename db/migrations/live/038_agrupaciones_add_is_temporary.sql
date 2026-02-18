-- 038_agrupaciones_add_is_temporary.sql (FINAL - idempotente)

ALTER TABLE agrupaciones
  ADD COLUMN IF NOT EXISTS is_temporary BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_agrupaciones_temporary
  ON agrupaciones(business_id, is_temporary)
  WHERE is_temporary = TRUE;

COMMENT ON COLUMN agrupaciones.is_temporary IS
'TRUE = "Sin Agrupación" temporal de un sub-negocio (se elimina al vaciarse). FALSE = agrupación normal.';