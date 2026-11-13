-- 097 · RRHH: hora de entrada por empleado y día (Diego, 12/11/2026).
-- Vacía = entra a la hora del turno. Se carga por celda o para toda la fila.
ALTER TABLE rrhh_celdas ADD COLUMN IF NOT EXISTS entrada TEXT;
