-- 144: conexión con Fudo por su API oficial (usuaria 17/11/2026). De Fudo se traen SOLO ventas
-- (regla multi-POS de la Guía) y nada sale de Lazarillo hacia Fudo: la API es de solo lectura y solo
-- se hacen pedidos GET. El cliente habilita «API Pública General» en Fudo, crea un usuario para
-- Lazarillo y pega su apiKey/apiSecret en Configuración › Conexiones (o en el alta del negocio).
-- Ver services/fudoService.js. Idempotente.

-- Una conexión por negocio. Claves y token cifrados (utils/cryptoField). El token dura 24 h.
CREATE TABLE IF NOT EXISTS integraciones_fudo (
  business_id        integer     PRIMARY KEY REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  branch_id          bigint,                 -- sucursal a la que van las ventas (null = principal)
  api_key            text        NOT NULL,   -- cifrada
  api_secret         text        NOT NULL,   -- cifrada
  token              text,                   -- cifrado
  token_exp          timestamptz,
  conectado_por      integer,
  conectado_at       timestamptz NOT NULL DEFAULT now(),
  ventas_hasta       date,                   -- último día de ventas traído completo
  ultimo_sync_at     timestamptz,
  ultimo_sync_error  text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Productos de Fudo y su vínculo con un artículo de Lazarillo (maxi_articles.articulo_id). Fudo suele
-- no tener código de producto, así que el cruce es por el id interno de Fudo: se sugiere por código o
-- nombre y el cliente confirma. Si después cambian el nombre en Fudo, el vínculo sigue.
CREATE TABLE IF NOT EXISTS fudo_productos (
  business_id      integer     NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  fudo_id          text        NOT NULL,
  nombre           text,
  categoria        text,
  codigo           text,
  precio           numeric(14,2),
  activo           boolean,
  articulo_id      integer,                  -- vínculo confirmado
  sugerido_id      integer,                  -- sugerencia automática (por código o nombre)
  vinculado_por    integer,
  vinculado_at     timestamptz,
  visto_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, fudo_id)
);
CREATE INDEX IF NOT EXISTS fudo_productos_sin_vincular_idx ON fudo_productos (business_id) WHERE articulo_id IS NULL;

-- Ventas tal como vienen de Fudo, por día y producto (con o sin vínculo). Las vinculadas se vuelcan a
-- sales_daily_items con source='fudo'; al vincular un producto se vuelcan sus días sin volver a Fudo.
CREATE TABLE IF NOT EXISTS fudo_ventas_dia (
  business_id  integer       NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  day          date          NOT NULL,
  fudo_id      text          NOT NULL,
  qty          numeric(14,3) NOT NULL DEFAULT 0,
  amount       numeric(14,2) NOT NULL DEFAULT 0,
  traida_at    timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, day, fudo_id)
);
