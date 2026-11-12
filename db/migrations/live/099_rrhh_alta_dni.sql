-- 099 · RRHH: fecha de alta y DNI del empleado (Diego, 12/11/2026).
-- El DNI no es obligatorio por ahora; más adelante va a ser la clave única de cada persona
-- para accesos y fichajes. Con réplica de MaxiRest se completan solos (fecha_ing / nro_doc)
-- sin pisar lo cargado a mano.
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS fecha_alta DATE;
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS dni TEXT;
CREATE INDEX IF NOT EXISTS rrhh_empleados_dni_idx ON rrhh_empleados (business_id, dni) WHERE dni IS NOT NULL;
