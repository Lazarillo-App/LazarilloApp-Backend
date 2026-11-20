-- 157_conciliacion_traslados.sql — Mandar un registro de la conciliación a otro PDV (Diego 20/11/2026:
-- «a veces los clientes transfieren por error a la otra sucursal o tenemos que hacer factura desde Ramos
-- para San Justo; lo tildo y aprieto el PDV donde lo quiero mandar»).
-- Un traslado mueve UNA fila de una fuente (ventas, banco o cobros de cta. cte.) de la conciliación de
-- una sucursal a la de otra. La fila viaja entera (fila) para que el destino la vea aunque su fuente
-- no la tenga. Si se vuelve a mandar al PDV de origen, el traslado se borra.
CREATE TABLE IF NOT EXISTS conciliacion_traslados (
  business_id integer     NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  tipo        text        NOT NULL CHECK (tipo IN ('ventas', 'banco', 'pagos')),
  clave       text        NOT NULL,          -- id estable de la fila (mxv:…, mp…, mxp:…)
  desde_suc   integer     NOT NULL DEFAULT 0,
  hacia_suc   integer     NOT NULL DEFAULT 0,
  fila        jsonb       NOT NULL,
  fecha       date,
  importe     numeric,
  creado_por  integer,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, tipo, clave)
);
CREATE INDEX IF NOT EXISTS conciliacion_traslados_hacia ON conciliacion_traslados (business_id, hacia_suc);
CREATE INDEX IF NOT EXISTS conciliacion_traslados_desde ON conciliacion_traslados (business_id, desde_suc);
