-- 124: tablero de tareas del equipo en el panel de super usuarios (usuaria 13/11/2026).
-- Mairene y Diego se anotan pendientes, los mueven de estado, los editan y les dejan notas.
-- Idempotente: corre en cada arranque.

CREATE TABLE IF NOT EXISTS super_tareas (
  id           BIGSERIAL PRIMARY KEY,
  titulo       TEXT NOT NULL,
  detalle      TEXT,
  estado       TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'en_curso', 'hecha')),
  prioridad    TEXT NOT NULL DEFAULT 'normal' CHECK (prioridad IN ('alta', 'normal', 'baja')),
  asignado_a   BIGINT,
  creado_por   BIGINT,
  hecha_por    BIGINT,
  hecha_at     TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS super_tareas_estado_idx ON super_tareas (estado, updated_at DESC);

CREATE TABLE IF NOT EXISTS super_tareas_notas (
  id          BIGSERIAL PRIMARY KEY,
  tarea_id    BIGINT NOT NULL REFERENCES super_tareas(id) ON DELETE CASCADE,
  autor_id    BIGINT,
  texto       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS super_tareas_notas_tarea_idx ON super_tareas_notas (tarea_id, created_at);
