-- 131: Mercado Pago guardado ENTERO (Diego 14/11/2026: «cuando trae lo de bancos debe traer todo,
-- no parcial con algunas columnas; si MP suma una columna, hacer el barrido hacia atrás»).
-- Cada pago tal cual lo manda MP (raw). Las filas de la conciliación / Movimientos bancarios se
-- arman desde acá (services/mercadopagoService.js → derivarRango).
--   rol: 'cobro' (cobró la cuenta) | 'pago' (pagó la cuenta)
--   fecha: día de creación del pago, hora de Argentina (lo que usa la búsqueda de MP)
--   extra: lo que suma el reporte de liberaciones (nombre y documento del pagador)
CREATE TABLE IF NOT EXISTS mp_pagos (
  business_id  integer     NOT NULL,
  sucursal     integer     NOT NULL DEFAULT 0,
  rol          text        NOT NULL CHECK (rol IN ('cobro', 'pago')),
  mp_id        bigint      NOT NULL,
  fecha        date,
  estado       text,
  raw          jsonb       NOT NULL,
  extra        jsonb,
  actualizado  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sucursal, mp_id, rol)
);
CREATE INDEX IF NOT EXISTS mp_pagos_fecha_idx ON mp_pagos (business_id, sucursal, fecha);

-- Historial completo (se trae solo, hacia atrás, una vez por cuenta) y versión de las filas armadas.
ALTER TABLE integraciones_mercadopago ADD COLUMN IF NOT EXISTS historial_hasta date;
ALTER TABLE integraciones_mercadopago ADD COLUMN IF NOT EXISTS historial_completo boolean NOT NULL DEFAULT false;
ALTER TABLE integraciones_mercadopago ADD COLUMN IF NOT EXISTS version_filas integer NOT NULL DEFAULT 0;
