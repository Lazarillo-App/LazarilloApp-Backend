-- 125: avisos del panel de super usuarios (usuaria 13/11/2026). Todo lo que pasa en el panel
-- (tareas, notas, pedidos de clientes, ajustes) queda acá y sale en la solapa "Admins" de la
-- campana: "Mairene agregó una tarea", "Diego agregó una nota". Idempotente.

CREATE TABLE IF NOT EXISTS super_actividad (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    BIGINT,
  tipo        TEXT NOT NULL,          -- tarea | nota | pedido | ajuste
  accion      TEXT NOT NULL,          -- texto corto: "agregó una tarea", "marcó como hecha"…
  titulo      TEXT,                   -- de qué: título de la tarea, "Pedido #12"…
  detalle     TEXT,                   -- un extracto (la nota, la respuesta)
  tarea_id    BIGINT,
  pedido_id   BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS super_actividad_fecha_idx ON super_actividad (created_at DESC);

-- Hasta cuándo vio cada super usuario los avisos (en la base: vale igual en el celu y en la compu).
CREATE TABLE IF NOT EXISTS super_actividad_visto (
  user_id     BIGINT PRIMARY KEY,
  visto_hasta TIMESTAMPTZ NOT NULL DEFAULT now()
);
