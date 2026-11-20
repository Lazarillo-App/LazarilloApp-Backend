-- 158_conciliacion_traslados_org.sql — Traslados a cualquier PDV de la organización (Diego 20/11/2026:
-- «otro PDV puede ser cualquiera de la organización, incluso el Bar»). business_id sigue siendo el
-- negocio de ORIGEN; hacia_bid es el negocio destino (puede ser el mismo).
ALTER TABLE conciliacion_traslados ADD COLUMN IF NOT EXISTS hacia_bid integer REFERENCES public.app_businesses(id) ON DELETE CASCADE;
UPDATE conciliacion_traslados SET hacia_bid = business_id WHERE hacia_bid IS NULL;
CREATE INDEX IF NOT EXISTS conciliacion_traslados_hacia_bid ON conciliacion_traslados (hacia_bid, hacia_suc);
