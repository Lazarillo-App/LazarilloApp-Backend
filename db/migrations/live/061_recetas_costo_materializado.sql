-- Materialización de costos de receta.
-- costo_total ya existe (SUM cantidad × costo_unitario, SIN merma).
-- Agregamos el costo unitario resuelto (por unidad base: gr/ml/u/porcion)
-- y el costo con merma (preparado para merma-por-negocio, se llena en tanda #3).

ALTER TABLE recetas
  ADD COLUMN IF NOT EXISTS costo_unitario        numeric(14,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS costo_total_con_merma numeric(14,4) NOT NULL DEFAULT 0;

COMMENT ON COLUMN recetas.costo_unitario IS
  'Costo por unidad base de rendimiento: por porcion/u si rendimiento_unidad in (porcion,u); por gr si (gr,kg); por ml si (ml,lt). El footer deriva la vista por kg/L multiplicando x1000.';
COMMENT ON COLUMN recetas.costo_total_con_merma IS
  'costo_total ajustado por merma. Por ahora = costo_total (merma global). Se materializa por negocio en tanda merma-por-local.';