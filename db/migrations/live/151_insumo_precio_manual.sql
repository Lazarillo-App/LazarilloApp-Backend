-- 19/11/2026 — Costo manual de un insumo como excepción (Diego): se carga desde el modal y vale
-- hasta que entra una compra nueva de ese insumo, que lo reemplaza. precio_manual_at marca cuándo
-- se cargó a mano; la compra nueva lo vuelve a NULL.
ALTER TABLE insumos ADD COLUMN IF NOT EXISTS precio_manual_at TIMESTAMPTZ;
