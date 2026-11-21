-- 162: Tareas operativas · producción de elaborados (usuaria 21/11/2026).
-- El jefe de cocina (o dueño/admin) programa la semana en tandas de receta (1, ½…) por día y turno,
-- la delega a una persona del staff y/o a una plaza; el cocinero la ejecuta desde el celular con
-- cronómetro, tilda los ingredientes (la receta escalada a las tandas) y carga lo que rindió.
-- Si cambia un ingrediente (no había, otro distinto, otra cantidad) sigue trabajando: el cambio
-- queda pendiente y el dueño/admin lo aprueba o lo rechaza. Cada tarea tiene su hilo de
-- observaciones. Reemplaza la planilla «06 - Tareas Operativas.xlsm» (prod_prog / produccion).
-- Idempotente: corre en cada arranque. Tablas nuevas, no toca nada existente.

-- Turnos de producción: cada negocio arma los suyos (Mañana, Tarde, Noche, …).
CREATE TABLE IF NOT EXISTS produccion_turnos (
  id           SERIAL PRIMARY KEY,
  business_id  BIGINT      NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  nombre       TEXT        NOT NULL,
  desde        TEXT,                     -- "08:00" (informativo)
  hasta        TEXT,
  orden        INT         NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_produccion_turnos_biz ON produccion_turnos (business_id) WHERE deleted_at IS NULL;

-- Lo que el jefe deja fijo por elaborado: minutos que lleva una tanda (para estimar) y la plaza /
-- el responsable que se proponen al programarlo.
CREATE TABLE IF NOT EXISTS produccion_elaborados (
  business_id          BIGINT      NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  insumo_id            BIGINT      NOT NULL,
  minutos_tanda        NUMERIC(7,1),
  plaza_id             INT,
  responsable_user_id  BIGINT,
  updated_by           BIGINT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, insumo_id)
);

-- Una tarea = producir un elaborado (o una tarea libre) un día, en un turno.
-- estado: pendiente → en_curso ⇄ pausada → hecha (o cancelada).
-- El tiempo real es segundos_trabajados (suma de los tramos en curso, sin las pausas).
-- cambios: NULL = sin cambios de ingredientes; 'pendiente' = alguno espera decisión; 'resuelto'.
CREATE TABLE IF NOT EXISTS produccion_tareas (
  id                   BIGSERIAL PRIMARY KEY,
  business_id          BIGINT        NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  tipo                 TEXT          NOT NULL DEFAULT 'produccion',   -- produccion | otra
  insumo_id            BIGINT,                                        -- el elaborado
  titulo               TEXT          NOT NULL,                        -- nombre del elaborado al programar, o texto libre
  fecha                DATE          NOT NULL,
  turno_id             INT,
  tandas               NUMERIC(8,3)  NOT NULL DEFAULT 1,
  rinde_esperado       NUMERIC(14,3),                                 -- rendimiento de la receta × tandas
  unidad               TEXT,
  responsable_user_id  BIGINT,
  plaza_id             INT,
  sector_id            INT,
  minutos_estimados    NUMERIC(7,1),
  estado               TEXT          NOT NULL DEFAULT 'pendiente',
  iniciada_at          TIMESTAMPTZ,
  corriendo_desde      TIMESTAMPTZ,                                   -- NULL si no está en curso
  terminada_at         TIMESTAMPTZ,
  segundos_trabajados  INT           NOT NULL DEFAULT 0,
  rinde_real           NUMERIC(14,3),
  cambios              TEXT,
  orden                INT           NOT NULL DEFAULT 0,
  creada_por           BIGINT,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_produccion_tareas_fecha ON produccion_tareas (business_id, fecha) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_produccion_tareas_resp  ON produccion_tareas (responsable_user_id, fecha) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_produccion_tareas_cambios ON produccion_tareas (business_id) WHERE cambios = 'pendiente' AND deleted_at IS NULL;

-- Los ingredientes que se usaron: se copian de la receta (escalada a las tandas) al iniciar la
-- tarea, así un cambio posterior de la receta no altera lo ya producido.
-- Un cambio del cocinero va en *_real + motivo, con cambio = 'pendiente' hasta que se decide:
-- 'aprobado' (solo esta producción) | 'rechazado'. agregado = no estaba en la receta.
CREATE TABLE IF NOT EXISTS produccion_tarea_insumos (
  id              BIGSERIAL PRIMARY KEY,
  tarea_id        BIGINT        NOT NULL REFERENCES produccion_tareas(id) ON DELETE CASCADE,
  receta_item_id  BIGINT,
  insumo_id       BIGINT,
  nombre          TEXT          NOT NULL,
  cantidad        NUMERIC(14,4),
  unidad          TEXT,
  insumo_real_id  BIGINT,
  nombre_real     TEXT,
  cantidad_real   NUMERIC(14,4),
  unidad_real     TEXT,
  falta           BOOLEAN       NOT NULL DEFAULT FALSE,               -- no había y no se reemplazó
  agregado        BOOLEAN       NOT NULL DEFAULT FALSE,
  usado           BOOLEAN       NOT NULL DEFAULT FALSE,
  motivo          TEXT,
  cambio          TEXT,
  decidido_por    BIGINT,
  decidido_at     TIMESTAMPTZ,
  nota_decision   TEXT,
  orden           INT           NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_produccion_tarea_insumos_tarea ON produccion_tarea_insumos (tarea_id);

-- Hilo de la tarea: observaciones de jefe y cocinero + lo que fue pasando (inició, pausó, cambió
-- un ingrediente, se aprobó…). tipo: nota | estado | cambio | decision | edicion.
CREATE TABLE IF NOT EXISTS produccion_eventos (
  id          BIGSERIAL PRIMARY KEY,
  tarea_id    BIGINT       NOT NULL REFERENCES produccion_tareas(id) ON DELETE CASCADE,
  user_id     BIGINT,
  tipo        TEXT         NOT NULL,
  texto       TEXT,
  metadata    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_produccion_eventos_tarea ON produccion_eventos (tarea_id, created_at);

-- Alcance del cambio de un ingrediente (usuaria 21/11/2026):
--   'produccion' = solo esta producción (no había, vino otro distinto): lo decide dueño/admin acá.
--   'receta'     = cambio permanente de la receta: arma una propuesta de receta (receta_proposals,
--                  proposal_id) que el dueño/admin aprueba o rechaza en Aprobaciones; al decidirse,
--                  el cambio de la producción toma la misma decisión.
ALTER TABLE produccion_tarea_insumos ADD COLUMN IF NOT EXISTS alcance TEXT NOT NULL DEFAULT 'produccion';
ALTER TABLE produccion_tarea_insumos ADD COLUMN IF NOT EXISTS proposal_id BIGINT;
