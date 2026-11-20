-- 161 · Recetas de tipo Servicio (Diego 20/11/2026, canchas de Container FC). Un servicio no tiene
-- insumos: su costo sale de los costos estructurales del local y de las horas que se usa.
-- Ver services/servicioCosto.js. NULL = receta común (producto o promo).
ALTER TABLE recetas ADD COLUMN IF NOT EXISTS servicio JSONB;
CREATE INDEX IF NOT EXISTS recetas_servicio_biz_idx ON recetas (business_id) WHERE servicio IS NOT NULL;
