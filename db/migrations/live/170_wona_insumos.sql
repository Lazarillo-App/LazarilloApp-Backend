-- 170: Wona también arma insumos y recetas del buffet (usuaria 25/11/2026: «insumos no tenemos?»).
-- En un buffet cada producto que se revende es artículo e insumo a la vez: se crea un insumo por producto
-- (unidad «u», rubro = grupo de Wona, costo de Wona como precio inicial) y la receta del artículo con
-- 1 unidad de ese insumo, así Artículos muestra costo y rentabilidad. Lo editado en Lazarillo no se
-- pisa (insumo_aplicado guarda lo último que escribió Lazarillo). Ver services/wonaService.js. Idempotente.
ALTER TABLE wona_productos
  ADD COLUMN IF NOT EXISTS insumo_id integer,
  ADD COLUMN IF NOT EXISTS insumo_aplicado jsonb NOT NULL DEFAULT '{}'::jsonb;
