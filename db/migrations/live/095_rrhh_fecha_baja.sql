-- 095 · RRHH: fecha de baja manual del empleado (Diego, 12/11/2026).
-- Dar de baja desde Nómina pide la fecha (vacía = hoy). Reactivar la borra.
-- La baja que viene de MaxiRest sigue en baja_maxi (073).
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS fecha_baja DATE;
