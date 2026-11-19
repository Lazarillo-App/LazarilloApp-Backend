-- 153: marcas a mano sobre los movimientos bancarios (Diego 19/11/2026: «en lo que salió, un botón que diga
-- Gasto personal y un KPI con los gastos personales»). Una fila por movimiento marcado; sin fila = no marcado.
-- mov_id = el id del movimiento en las fuentes de la conciliación (mpp<id>, mpr:…, etc.), estable entre lecturas.
-- Idempotente (corre en cada arranque).
CREATE TABLE IF NOT EXISTS mov_marcas (
  business_id bigint NOT NULL,
  sucursal    integer NOT NULL,
  mov_id      text NOT NULL,
  marca       text NOT NULL DEFAULT 'personal',
  importe     numeric(14,2),
  fecha       date,
  creado_por  integer,
  creado_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sucursal, mov_id)
);
