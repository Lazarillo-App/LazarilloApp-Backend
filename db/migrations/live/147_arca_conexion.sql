-- 147: ARCA automático desde la PC del cliente (usuaria 18/11/2026, opción C: robot propio).
-- El robot corre en la PC vinculada del kit, entra a ARCA con la CUIT y clave del CLIENTE (guardadas
-- cifradas SOLO en esa PC: acá nunca se guarda la clave), baja «Mis Comprobantes › Recibidos» y los
-- sube a Lazarillo, que los pasa por el importador del Panel (services/gestion/arca/api.js).
-- Idempotente.

-- Qué quiere el negocio: cada cuánto y, si pidió «Traer ahora», qué rango.
CREATE TABLE IF NOT EXISTS arca_conexion (
  business_id       integer     PRIMARY KEY REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  frecuencia        text        NOT NULL DEFAULT 'semanal',   -- diaria | semanal | mensual | apagada
  pedido_desde      date,                                    -- «Traer ahora» pendiente
  pedido_hasta      date,
  pedido_at         timestamptz,
  pedido_por        integer,
  pc_id             integer,                                 -- PC que tiene la clave (kit_pcs.id)
  cuit              text,                                    -- la CUIT que informó la PC (no la clave)
  vinculada_at      timestamptz,
  recibidos_hasta   date,                                    -- hasta qué día ya se trajo
  ultima_corrida_at timestamptz,
  ultimo_error      text,
  ultimo_error_at   timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Cada archivo que llegó (del robot o detectado en Descargas): para mostrar el historial.
CREATE TABLE IF NOT EXISTS arca_subidas (
  id            serial      PRIMARY KEY,
  business_id   integer     NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  pc_id         integer,
  origen        text        NOT NULL,       -- robot | descargas
  desde         date,
  hasta         date,
  comprobantes  integer     NOT NULL DEFAULT 0,
  nuevos        integer     NOT NULL DEFAULT 0,
  actualizados  integer     NOT NULL DEFAULT 0,
  error         text,
  creado_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS arca_subidas_negocio ON arca_subidas (business_id, creado_at DESC);
