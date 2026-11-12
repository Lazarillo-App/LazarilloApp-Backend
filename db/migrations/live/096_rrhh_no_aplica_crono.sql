-- 096 · RRHH: empleados que no van en cronogramas + sugerencia de baja (Diego, 12/11/2026).
-- El espacio de cada empleado NO se carga: se aprende de los cronogramas.
-- Lo único manual es marcar "No aplica a cronogramas" (contador, dueño, técnicos).
-- Si un empleado activo pasa 8 semanas sin turnos se sugiere darle la baja;
-- "Sigue activo" guarda la fecha y silencia la sugerencia por otras 8 semanas.
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS no_aplica_crono BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE rrhh_empleados ADD COLUMN IF NOT EXISTS baja_sug_silenciada DATE;
