-- 122_mercadopago.sql — Conexión de cada negocio con su cuenta de Mercado Pago (14/11/2026).
-- El negocio autoriza a Lazarillo desde Configuración › Conexiones (OAuth de Mercado Pago). Los
-- tokens se guardan cifrados (utils/cryptoField, ENCRYPTION_KEY). Con eso Lazarillo trae los
-- cobros de la cuenta para la conciliación bancaria (y más adelante pagos, compras, caja).

CREATE TABLE IF NOT EXISTS integraciones_mercadopago (
  business_id       integer     PRIMARY KEY REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  mp_user_id        bigint,
  mp_nickname       text,
  mp_email          text,
  access_token      text        NOT NULL,   -- cifrado
  refresh_token     text,                   -- cifrado
  expira_at         timestamptz,
  live_mode         boolean,
  conectado_por     integer,
  conectado_at      timestamptz NOT NULL DEFAULT now(),
  ultimo_sync_at    timestamptz,
  ultimo_sync_desde date,
  ultimo_sync_hasta date,
  ultimo_sync_error text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
