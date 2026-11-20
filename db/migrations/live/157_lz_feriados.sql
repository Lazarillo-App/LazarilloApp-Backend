-- 157 · Calendario de feriados ÚNICO de Lazarillo, por zona (Diego 20/11/2026, pendiente
-- «Calendario de feriados único»). Antes había tres listas (FECHAS_DEF sembrado en cada negocio,
-- services/gestion/feriados.js y el tablero viejo) y ninguna coincidía.
--   zona: 'AR' nacional · 'AR-B' provincia de Buenos Aires · 'AR-C' CABA · 'AR-X' Córdoba …
--   tipo: inamovible | trasladable | no_laborable (fines turísticos, Jueves Santo) | extraordinario
-- Cada negocio hereda AR + su provincia (app_businesses.zona_feriados), sin copiar: rrhh_fechas
-- queda para lo propio (eventos, cerrados, vísperas y la excepción «este día abrimos»).
CREATE TABLE IF NOT EXISTS lz_feriados (
  id          BIGSERIAL PRIMARY KEY,
  fecha       DATE NOT NULL,
  nombre      TEXT NOT NULL,
  tipo        TEXT NOT NULL DEFAULT 'inamovible',
  zona        TEXT NOT NULL DEFAULT 'AR',
  fuente      TEXT,
  updated_by  BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fecha, zona)
);
CREATE INDEX IF NOT EXISTS ix_lz_feriados_fecha ON lz_feriados (fecha);

ALTER TABLE app_businesses ADD COLUMN IF NOT EXISTS zona_feriados TEXT;

-- Zona de los negocios que ya sabemos (Diego 20/11/2026): Container = provincia de Buenos Aires,
-- Comercio (Núñez) = CABA. Solo si todavía no tienen zona; el resto queda nacional hasta que se elija.
UPDATE app_businesses SET zona_feriados = 'AR-B' WHERE id IN (147, 204) AND zona_feriados IS NULL;
UPDATE app_businesses SET zona_feriados = 'AR-C' WHERE id = 210 AND zona_feriados IS NULL;

-- Carga inicial 2025–2027. ON CONFLICT DO NOTHING: lo que se edite desde Panel super no se pisa.
INSERT INTO lz_feriados (fecha, nombre, tipo, zona, fuente) VALUES
  -- 2025 (calendario oficial; trasladables ya movidos)
  ('2025-01-01','Año Nuevo','inamovible','AR','Ley 27.399'),
  ('2025-03-03','Carnaval','inamovible','AR','Ley 27.399'),
  ('2025-03-04','Carnaval','inamovible','AR','Ley 27.399'),
  ('2025-03-24','Día de la Memoria','inamovible','AR','Ley 27.399'),
  ('2025-04-02','Malvinas','inamovible','AR','Ley 27.399'),
  ('2025-04-18','Viernes Santo','inamovible','AR','Ley 27.399'),
  ('2025-05-01','Día del Trabajador','inamovible','AR','Ley 27.399'),
  ('2025-05-02','Fines turísticos','no_laborable','AR','Calendario oficial 2025'),
  ('2025-05-25','Revolución de Mayo','inamovible','AR','Ley 27.399'),
  ('2025-06-16','Gral. Güemes','trasladable','AR','Ley 27.399'),
  ('2025-06-20','Gral. Belgrano','inamovible','AR','Ley 27.399'),
  ('2025-07-09','Independencia','inamovible','AR','Ley 27.399'),
  ('2025-08-15','Fines turísticos','no_laborable','AR','Calendario oficial 2025'),
  ('2025-08-17','Gral. San Martín','trasladable','AR','Ley 27.399'),
  ('2025-10-10','Diversidad Cultural','trasladable','AR','Ley 27.399'),
  ('2025-11-21','Fines turísticos','no_laborable','AR','Calendario oficial 2025'),
  ('2025-11-24','Soberanía Nacional','trasladable','AR','Ley 27.399'),
  ('2025-12-08','Inmaculada Concepción','inamovible','AR','Ley 27.399'),
  ('2025-12-25','Navidad','inamovible','AR','Ley 27.399'),
  -- 2026
  ('2026-01-01','Año Nuevo','inamovible','AR','Ley 27.399'),
  ('2026-02-16','Carnaval','inamovible','AR','Ley 27.399'),
  ('2026-02-17','Carnaval','inamovible','AR','Ley 27.399'),
  ('2026-03-23','Fines turísticos','no_laborable','AR','Calendario oficial 2026'),
  ('2026-03-24','Día de la Memoria','inamovible','AR','Ley 27.399'),
  ('2026-04-02','Malvinas · Jueves Santo','inamovible','AR','Ley 27.399'),
  ('2026-04-03','Viernes Santo','inamovible','AR','Ley 27.399'),
  ('2026-05-01','Día del Trabajador','inamovible','AR','Ley 27.399'),
  ('2026-05-25','Revolución de Mayo','inamovible','AR','Ley 27.399'),
  ('2026-06-15','Gral. Güemes','trasladable','AR','Ley 27.399'),
  ('2026-06-20','Gral. Belgrano','inamovible','AR','Ley 27.399'),
  ('2026-07-09','Independencia','inamovible','AR','Ley 27.399'),
  ('2026-07-10','Fines turísticos','no_laborable','AR','Calendario oficial 2026'),
  ('2026-08-17','Gral. San Martín','trasladable','AR','Ley 27.399'),
  ('2026-10-12','Diversidad Cultural','trasladable','AR','Ley 27.399'),
  ('2026-11-09','Visita del papa León XIV','extraordinario','AR','DNU 1103/2026'),
  ('2026-11-10','Visita del papa León XIV','extraordinario','AR-C','DNU 1103/2026'),
  ('2026-11-10','Visita del papa León XIV','extraordinario','AR-X','DNU 1103/2026'),
  ('2026-11-11','Visita del papa León XIV','extraordinario','AR-B','DNU 1103/2026'),
  ('2026-11-23','Soberanía Nacional','trasladable','AR','Ley 27.399 (trasladado del 20/11)'),
  ('2026-12-07','Fines turísticos','no_laborable','AR','Calendario oficial 2026'),
  ('2026-12-08','Inmaculada Concepción','inamovible','AR','Ley 27.399'),
  ('2026-12-25','Navidad','inamovible','AR','Ley 27.399'),
  -- 2027: por la ley (trasladables ya movidos). Los días turísticos salen por decreto a fin de 2026.
  ('2027-01-01','Año Nuevo','inamovible','AR','Ley 27.399'),
  ('2027-02-08','Carnaval','inamovible','AR','Ley 27.399'),
  ('2027-02-09','Carnaval','inamovible','AR','Ley 27.399'),
  ('2027-03-24','Día de la Memoria','inamovible','AR','Ley 27.399'),
  ('2027-03-25','Jueves Santo','no_laborable','AR','Ley 27.399'),
  ('2027-03-26','Viernes Santo','inamovible','AR','Ley 27.399'),
  ('2027-04-02','Malvinas','inamovible','AR','Ley 27.399'),
  ('2027-05-01','Día del Trabajador','inamovible','AR','Ley 27.399'),
  ('2027-05-25','Revolución de Mayo','inamovible','AR','Ley 27.399'),
  ('2027-06-20','Gral. Belgrano','inamovible','AR','Ley 27.399'),
  ('2027-06-21','Gral. Güemes','trasladable','AR','Ley 27.399 (17/6 → lunes)'),
  ('2027-07-09','Independencia','inamovible','AR','Ley 27.399'),
  ('2027-08-16','Gral. San Martín','trasladable','AR','Ley 27.399 (17/8 → lunes)'),
  ('2027-10-11','Diversidad Cultural','trasladable','AR','Ley 27.399 (12/10 → lunes)'),
  ('2027-11-20','Soberanía Nacional','trasladable','AR','Ley 27.399 (sábado, no se mueve)'),
  ('2027-12-08','Inmaculada Concepción','inamovible','AR','Ley 27.399'),
  ('2027-12-25','Navidad','inamovible','AR','Ley 27.399')
ON CONFLICT (fecha, zona) DO NOTHING;
