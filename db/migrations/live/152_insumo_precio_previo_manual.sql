-- 19/11/2026 — Deshacer el costo manual de un insumo (Diego): si el insumo no tiene compras,
-- vuelve al precio que tenía antes de cargarlo a mano (guardado acá).
ALTER TABLE insumos ADD COLUMN IF NOT EXISTS precio_previo_manual NUMERIC;
