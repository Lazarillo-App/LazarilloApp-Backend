-- 130: pendientes de desarrollo por módulo y con el negocio de donde vienen (Diego 14/11/2026).
-- El tablero de super usuarios pasa a ser la guía de trabajo: cada tarea tiene módulo, negocio de
-- origen (NULL = Lazarillo / todos) y, si salió de un pedido de un cliente, el pedido.
-- La prioridad (alta/normal/baja) se muestra como 3/2/1 estrellas. Idempotente.
ALTER TABLE super_tareas ADD COLUMN IF NOT EXISTS modulo      TEXT NOT NULL DEFAULT 'general';
ALTER TABLE super_tareas ADD COLUMN IF NOT EXISTS business_id BIGINT;
ALTER TABLE super_tareas ADD COLUMN IF NOT EXISTS pedido_id   BIGINT;
CREATE INDEX IF NOT EXISTS super_tareas_modulo_idx ON super_tareas (modulo, estado);
