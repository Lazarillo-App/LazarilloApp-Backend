-- 093 · Plazas de despacho: alias del ingrediente, solo para la vista (Diego 11/11/2026).
-- Ej. «PROVOLETA NONNA PIA» se ve como «PARMESANO». Vale para ese ingrediente en todas las
-- recetas y plazas, como el color y el «mostrar». NULL = se ve el nombre real.
ALTER TABLE despacho_colores ADD COLUMN IF NOT EXISTS alias TEXT;
