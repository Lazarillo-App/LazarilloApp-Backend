-- 092 · Plazas de despacho: qué muestra cada ingrediente en la tarjeta (Diego 11/11/2026).
-- Se elige POR INGREDIENTE y vale en todas las recetas/plazas (igual que el color):
--   'peso' (default) → la cantidad de la receta («75 g»)
--   'obs'            → la observación del renglón de la receta («1 DIP Y MEDIO»); si esa receta no
--                      tiene observación para el ingrediente, se muestra el peso.
ALTER TABLE despacho_colores ADD COLUMN IF NOT EXISTS mostrar TEXT;
ALTER TABLE despacho_colores ALTER COLUMN color DROP NOT NULL;
