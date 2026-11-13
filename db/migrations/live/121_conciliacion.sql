-- 121_conciliacion.sql — Módulo de conciliación bancaria (14/11/2026).
-- El módulo (de Diego) cruza las ventas del POS (informe 22 de MaxiRest) y las cobranzas de
-- cuenta corriente (informe 72) con los movimientos de Mercado Pago. Hasta ahora vivía solo en
-- el navegador; acá se guarda por negocio:
--   conciliacion_fuentes   → lo último que se subió de cada fuente (ya leído, en jsonb)
--   conciliacion_estado    → el trabajo hecho en un período (qué se concilió, propinas, notas…)
--   conciliacion_pagadores → la "memoria de pagadores" de las cuentas corrientes del negocio

CREATE TABLE IF NOT EXISTS conciliacion_fuentes (
  business_id integer     NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  tipo        text        NOT NULL CHECK (tipo IN ('ventas', 'pagos', 'banco', 'facturas_cc')),
  archivo     text,
  filas       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  cantidad    integer     NOT NULL DEFAULT 0,
  desde       date,
  hasta       date,
  origen      text        NOT NULL DEFAULT 'archivo',   -- 'archivo' | 'mercadopago' (más adelante)
  subido_por  integer,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, tipo)
);

CREATE TABLE IF NOT EXISTS conciliacion_estado (
  business_id integer     NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  periodo     text        NOT NULL,                     -- 'YYYY-MM-DD|YYYY-MM-DD'
  estado      jsonb       NOT NULL,
  updated_by  integer,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, periodo)
);

CREATE TABLE IF NOT EXISTS conciliacion_pagadores (
  business_id integer     PRIMARY KEY REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  mapa        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
