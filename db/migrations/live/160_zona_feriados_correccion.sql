-- 160 · Corrección de provincias (Diego 20/11/2026): Renato es Córdoba; Container = provincia de
-- Buenos Aires en todos los PDV de la organización (por ahora). Corre UNA sola vez (marca en
-- lz_migraciones_unicas): si después alguien cambia la provincia desde la app, no se pisa.
CREATE TABLE IF NOT EXISTS lz_migraciones_unicas (clave TEXT PRIMARY KEY, aplicada_at TIMESTAMPTZ NOT NULL DEFAULT now());
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lz_migraciones_unicas WHERE clave = '160_zona_feriados') THEN
    UPDATE app_businesses SET zona_feriados = 'AR-X' WHERE id = 231;
    UPDATE app_businesses SET zona_feriados = 'AR-B'
     WHERE organization_id IN (9, 19, 26) OR id = 220;
    INSERT INTO lz_migraciones_unicas (clave) VALUES ('160_zona_feriados');
  END IF;
END $$;
