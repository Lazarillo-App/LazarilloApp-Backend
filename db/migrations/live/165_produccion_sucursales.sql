-- 165: Producción y Mantenimiento por sucursal (usuaria 21/11/2026: "hay que separar por
-- sucursal, pueden ser diferentes"). Igual que RRHH: branch_id NULL = la principal.
-- Turnos, tareas, mermas, desperdicios y equipos son de cada sucursal; recetas, estimados por
-- elaborado y plazas siguen siendo del negocio. Idempotente: corre en cada arranque.
ALTER TABLE produccion_turnos       ADD COLUMN IF NOT EXISTS branch_id BIGINT;
ALTER TABLE produccion_tareas       ADD COLUMN IF NOT EXISTS branch_id BIGINT;
ALTER TABLE produccion_mermas       ADD COLUMN IF NOT EXISTS branch_id BIGINT;
ALTER TABLE produccion_desperdicios ADD COLUMN IF NOT EXISTS branch_id BIGINT;
ALTER TABLE mant_equipos            ADD COLUMN IF NOT EXISTS branch_id BIGINT;
CREATE INDEX IF NOT EXISTS ix_produccion_tareas_suc ON produccion_tareas (business_id, branch_id, fecha) WHERE deleted_at IS NULL;
