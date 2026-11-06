-- Concepto de caja de un rubro de insumos elegido en Lazarillo (Diego 06/11/2026: corregir desde el panel
-- «Sin rubro · por qué»). La importación de MaxiRest pisa cpto_caja; este valor no lo toca y manda.
ALTER TABLE insumo_rubros ADD COLUMN IF NOT EXISTS cpto_caja_lazarillo integer;
