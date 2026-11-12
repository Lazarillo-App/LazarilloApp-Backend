-- 098: «media porción» como unidad de rendimiento de una receta (Diego 12/11/2026).
-- Para el costo es la unidad del rendimiento ('u'), igual que 'porcion'; solo cambia el nombre.
ALTER TABLE recetas DROP CONSTRAINT IF EXISTS recetas_rendimiento_unidad_check;
ALTER TABLE recetas ADD CONSTRAINT recetas_rendimiento_unidad_check
  CHECK (rendimiento_unidad = ANY (ARRAY['porcion', 'media_porcion', 'u', 'lt', 'ml', 'kg', 'gr']::text[]));
