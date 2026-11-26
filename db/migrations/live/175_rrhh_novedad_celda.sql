-- 175 · RRHH: novedad de un día en el cronograma (usuaria 26/11/2026).
-- Lo puntual de ese día para esa persona (faltó, llegó tarde, horas extra, cambio de horario,
-- diligencia u otro) con nota. No es el horario general: cuando la semana se repite (o «+ Semana»),
-- la celda vuelve a `base` (el horario que tenía antes del cambio) y la novedad no se copia.
-- Queda como marca para el historial del mes (dueño y admin; RRHH no lo ve el staff).
-- Forma: { tipo, nota, base: { entrada, salida, horas, puesto } | null }. Idempotente.
ALTER TABLE rrhh_celdas ADD COLUMN IF NOT EXISTS novedad JSONB;
CREATE INDEX IF NOT EXISTS ix_rrhh_celdas_novedad ON rrhh_celdas(empleado_id) WHERE novedad IS NOT NULL;
