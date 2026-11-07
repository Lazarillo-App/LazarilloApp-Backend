-- 073 · RRHH: sincronización automática de la nómina con la réplica de MaxiRest.
-- baja_maxi = fecha de baja de MaxiRest que la sync ya aplicó (desactivó al
-- empleado). Si alguien lo reactiva a mano, la sync no lo vuelve a bajar salvo
-- que MaxiRest cargue una baja con OTRA fecha.
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS baja_maxi DATE;
