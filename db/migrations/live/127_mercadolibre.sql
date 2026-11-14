-- 127: conexión con Mercado Libre para traer las COMPRAS del negocio (usuaria 14/11/2026).
-- El negocio autoriza a Lazarillo (OAuth de Mercado Libre, Configuración › Conexiones). Lazarillo
-- trae las órdenes en las que el negocio es comprador y las muestra en el Panel de Gestión
-- (Sin carga › Mercado Libre) para cargarlas como factura con el modal de siempre.
-- Tokens cifrados (utils/cryptoField). Idempotente.

CREATE TABLE IF NOT EXISTS integraciones_mercadolibre (
  business_id       integer     PRIMARY KEY REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  ml_user_id        bigint,
  ml_nickname       text,
  ml_email          text,
  access_token      text        NOT NULL,   -- cifrado; dura 6 horas
  refresh_token     text,                   -- cifrado; se usa una sola vez (cada renovación trae otro)
  expira_at         timestamptz,
  conectado_por     integer,
  conectado_at      timestamptz NOT NULL DEFAULT now(),
  ultimo_sync_at    timestamptz,
  ultimo_sync_error text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Cada compra (orden de Mercado Libre donde el negocio compró). `estado_carga`: pendiente hasta
-- que se carga como factura en el Panel ('cargada') o se marca que no va ('descartada').
CREATE TABLE IF NOT EXISTS ml_compras (
  business_id    integer     NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  order_id       bigint      NOT NULL,
  fecha          timestamptz NOT NULL,
  total          numeric(14,2) NOT NULL DEFAULT 0,
  moneda         text,
  estado_orden   text,                    -- paid, cancelled, …
  vendedor_id    bigint,
  vendedor       text,
  items          jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- [{titulo, cantidad, precio}]
  estado_carga   text        NOT NULL DEFAULT 'pendiente' CHECK (estado_carga IN ('pendiente', 'cargada', 'descartada')),
  marcada_por    integer,
  marcada_at     timestamptz,
  traida_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, order_id)
);
CREATE INDEX IF NOT EXISTS ml_compras_pendientes_idx ON ml_compras (business_id, estado_carga, fecha DESC);
