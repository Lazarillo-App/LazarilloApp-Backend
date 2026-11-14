-- 124 · Plazas de despacho: qué muestra la plaza por defecto (Diego 14/11/2026: «peso, observación,
-- ambos debe ser global de la plaza y después, si quiero, gestiono individualmente»).
--   plazas.mostrar = 'peso' | 'obs' | 'ambos' → vale para todos los ingredientes de la plaza.
--   despacho_colores.mostrar (092) pasa a ser la EXCEPCIÓN de un ingrediente; NULL = sigue a la plaza.
ALTER TABLE plazas ADD COLUMN IF NOT EXISTS mostrar TEXT NOT NULL DEFAULT 'peso';
