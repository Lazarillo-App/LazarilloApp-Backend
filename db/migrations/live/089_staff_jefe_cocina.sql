-- 089: Jefe de cocina = subrol de Staff (Diego 11/11/2026).
-- user_assignments.subrol: NULL = staff común; 'jefe' = jefe de los sectores que tiene en sector_ids.
-- receta_proposals.jefe_ok_*: OK del jefe. En un sector con jefe, el admin ve la propuesta de un
-- cocinero recién después de ese OK (sin jefe, el circuito sigue igual que antes).
ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS subrol TEXT NULL;
ALTER TABLE receta_proposals ADD COLUMN IF NOT EXISTS jefe_ok_at TIMESTAMPTZ NULL;
ALTER TABLE receta_proposals ADD COLUMN IF NOT EXISTS jefe_ok_by BIGINT NULL;
