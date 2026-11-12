-- 101 · RRHH: hora de salida opcional por empleado y día (Diego, 12/11/2026).
-- Si se carga, la celda muestra entrada–salida. Vacía = no se informa.
ALTER TABLE rrhh_celdas ADD COLUMN IF NOT EXISTS salida TEXT;
