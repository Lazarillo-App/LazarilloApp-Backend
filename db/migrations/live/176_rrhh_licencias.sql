-- 176 · RRHH: vacaciones (y a futuro otras licencias) por rango de fechas (usuaria 27/11/2026).
-- No tocan el cronograma: el horario de la persona queda igual y la grilla marca esos días.
-- Sirven para contar días (en el mes y en el año) al liquidar. Solo dueño/admin (RRHH no lo ve el staff).
-- Idempotente.
CREATE TABLE IF NOT EXISTS rrhh_licencias (
  id           BIGSERIAL PRIMARY KEY,
  business_id  BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  empleado_id  BIGINT NOT NULL REFERENCES rrhh_empleados(id) ON DELETE CASCADE,
  tipo         TEXT NOT NULL DEFAULT 'vacaciones',
  desde        DATE NOT NULL,
  hasta        DATE NOT NULL,
  nota         TEXT,
  created_by   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (hasta >= desde)
);
CREATE INDEX IF NOT EXISTS ix_rrhh_licencias_biz ON rrhh_licencias(business_id, desde, hasta);
