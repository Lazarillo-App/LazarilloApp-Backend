-- 163: IPC mensual (INDEC, nivel general nacional) para comparar ventas de años distintos en
-- «pesos de hoy» (Diego 23/11/2026: el mes año por año, ajustado por IPC). Se llena sola desde
-- una fuente pública (ArgentinaDatos) la primera vez que se pide y se refresca cuando sale un
-- mes nuevo. Es la misma para todos los negocios. Solo se ajustan importes, nunca tickets ni
-- cubiertos. Idempotente: corre en cada arranque.
CREATE TABLE IF NOT EXISTS gestion_ipc (
  mes         DATE        PRIMARY KEY,  -- primer día del mes
  variacion   NUMERIC     NOT NULL,     -- % mensual (ej. 2,7)
  fuente      TEXT,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
