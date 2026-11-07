-- 074 · RRHH: cronogramas por sucursal (pedido de Diego, 07/11/2026).
-- La nómina es una sola por negocio; cada sucursal tiene sus espacios (y con
-- ellos sus semanas). branch_id NULL = sucursal principal (los datos que ya
-- existían quedan ahí, sin migrar nada).
-- Fechas especiales: los feriados son compartidos por todas las sucursales;
-- los eventos y cierres son de una sucursal (compartida = FALSE + branch_id).
ALTER TABLE rrhh_espacios ADD COLUMN IF NOT EXISTS branch_id BIGINT;
CREATE INDEX IF NOT EXISTS ix_rrhh_espacios_branch ON rrhh_espacios(business_id, branch_id);

ALTER TABLE rrhh_fechas ADD COLUMN IF NOT EXISTS branch_id BIGINT;
ALTER TABLE rrhh_fechas ADD COLUMN IF NOT EXISTS compartida BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE rrhh_fechas DROP CONSTRAINT IF EXISTS rrhh_fechas_business_id_fecha_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_rrhh_fechas_alcance
  ON rrhh_fechas (business_id, compartida, (COALESCE(branch_id, 0)), fecha);
