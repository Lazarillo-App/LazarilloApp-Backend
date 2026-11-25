-- 169: conexión con Wona Sports (usuaria 25/11/2026). Wona es el sistema de gestión de canchas y buffet
-- de clubes (app.wonasports.com). No tiene API pública: se usa la misma API que usa su página, con el
-- usuario y la clave que el cliente carga en Configuración › Conexiones, presentándose como
-- «Lazarillo-conector» y SOLO con pedidos GET (más el login): nada sale de Lazarillo hacia Wona.
-- Cada negocio de Lazarillo va con UNA sede de Wona (tenant). Ver services/wonaService.js. Idempotente.

CREATE TABLE IF NOT EXISTS integraciones_wona (
  business_id        integer     PRIMARY KEY REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  branch_id          bigint,                 -- sucursal a la que van las ventas (null = principal)
  usuario            text        NOT NULL,   -- cifrado
  clave              text        NOT NULL,   -- cifrada
  tenant_uuid        text        NOT NULL,   -- sede de Wona
  tenant_nombre      text,
  token              text,                   -- cifrado
  token_exp          timestamptz,
  traer              jsonb       NOT NULL DEFAULT '{"ventas":true,"articulos":true,"compras":true}'::jsonb,
  conectado_por      integer,
  conectado_at       timestamptz NOT NULL DEFAULT now(),
  ventas_hasta       date,                   -- último día traído completo
  compras_hasta      date,
  ultimo_sync_at     timestamptz,
  ultimo_sync_error  text,
  ultimo_resumen     jsonb,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Productos del buffet y tipos de cancha de Wona, con el artículo de Lazarillo que les toca.
-- wona_id: el uuid de la presentación (buffet) o «cancha:<actividad>» (turnos de esa actividad).
CREATE TABLE IF NOT EXISTS wona_productos (
  business_id  integer       NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  wona_id      text          NOT NULL,
  tipo         text          NOT NULL DEFAULT 'buffet',   -- buffet | cancha
  nombre       text,
  grupo        text,
  subgrupo     text,
  costo        numeric(14,2),
  precio       numeric(14,2),
  articulo_id  integer,
  visto_at     timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, wona_id)
);

-- Ventas por día y producto/cancha, tal como salen de Wona. Se vuelcan a sales_daily_items (source 'wona').
CREATE TABLE IF NOT EXISTS wona_ventas_dia (
  business_id  integer       NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  day          date          NOT NULL,
  wona_id      text          NOT NULL,
  qty          numeric(14,3) NOT NULL DEFAULT 0,
  amount       numeric(14,2) NOT NULL DEFAULT 0,
  traida_at    timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, day, wona_id)
);
