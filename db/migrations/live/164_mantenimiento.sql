-- 164: Mantenimiento de equipos (usuaria 21/11/2026; reemplaza Activos / MantPred / MantOM /
-- freidoras / heladeras de la planilla «06 - Tareas Operativas.xlsm»).
--  · mant_equipos: los equipos del negocio (heladeras, freidoras, hornos, envasadoras…)
--  · mant_planes: mantenimiento preventivo de cada equipo (cada N días/semanas/meses, qué días
--    se puede hacer, quién). Genera las órdenes solo, a medida que se acercan.
--  · mant_ordenes: órdenes de trabajo, preventivas (de un plan) o correctivas (una falla que
--    reportó alguien del equipo).
--  · mant_registros: registros rápidos del día a día (aceite de la freidora, limpieza y
--    temperatura de las heladeras…).
-- Idempotente: corre en cada arranque.

CREATE TABLE IF NOT EXISTS mant_equipos (
  id                  BIGSERIAL PRIMARY KEY,
  business_id         BIGINT        NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  nombre              TEXT          NOT NULL,
  rubro               TEXT          NOT NULL DEFAULT 'otro',      -- heladera | freidora | horno | maquina | otro
  marca               TEXT,
  modelo              TEXT,
  proveedor           TEXT,
  codigo              TEXT,
  ubicacion           TEXT,
  sector_id           INT,
  responsable_user_id BIGINT,
  fecha_compra        DATE,
  fecha_instalacion   DATE,
  precio              NUMERIC(14,2),
  estado              TEXT          NOT NULL DEFAULT 'activo',    -- activo | en_reparacion | baja
  fecha_baja          DATE,
  notas               TEXT,
  created_by          BIGINT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_mant_equipos_biz ON mant_equipos (business_id) WHERE deleted_at IS NULL;

-- dias_semana: días en que se puede hacer (0 = domingo … 6 = sábado); NULL = cualquiera.
CREATE TABLE IF NOT EXISTS mant_planes (
  id                  BIGSERIAL PRIMARY KEY,
  business_id         BIGINT        NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  equipo_id           BIGINT        NOT NULL REFERENCES mant_equipos(id) ON DELETE CASCADE,
  nombre              TEXT          NOT NULL,
  descripcion         TEXT,
  cada_n              INT           NOT NULL DEFAULT 1,
  unidad              TEXT          NOT NULL DEFAULT 'meses',     -- dias | semanas | meses
  dias_semana         SMALLINT[],
  responsable_user_id BIGINT,
  nota_obligatoria    BOOLEAN       NOT NULL DEFAULT FALSE,
  activo              BOOLEAN       NOT NULL DEFAULT TRUE,
  ultima              DATE,
  proxima             DATE          NOT NULL,
  created_by          BIGINT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_mant_planes_equipo ON mant_planes (equipo_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mant_ordenes (
  id                  BIGSERIAL PRIMARY KEY,
  business_id         BIGINT        NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  equipo_id           BIGINT        NOT NULL REFERENCES mant_equipos(id) ON DELETE CASCADE,
  plan_id             BIGINT,
  tipo                TEXT          NOT NULL DEFAULT 'preventivo', -- preventivo | correctivo
  titulo              TEXT          NOT NULL,
  descripcion         TEXT,
  fecha               DATE          NOT NULL,
  responsable_user_id BIGINT,
  urgente             BOOLEAN       NOT NULL DEFAULT FALSE,
  estado              TEXT          NOT NULL DEFAULT 'pendiente', -- pendiente | hecha | cancelada
  reportada_por       BIGINT,
  hecha_por           BIGINT,
  hecha_at            TIMESTAMPTZ,
  nota                TEXT,
  costo               NUMERIC(14,2),
  proveedor           TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_mant_ordenes_biz ON mant_ordenes (business_id, estado, fecha);
CREATE INDEX IF NOT EXISTS ix_mant_ordenes_plan ON mant_ordenes (plan_id) WHERE estado = 'pendiente';

-- tipo: aceite_filtrado | aceite_cambio | aceite_carga | limpieza | temperatura | otro
CREATE TABLE IF NOT EXISTS mant_registros (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT        NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  equipo_id   BIGINT        NOT NULL REFERENCES mant_equipos(id) ON DELETE CASCADE,
  tipo        TEXT          NOT NULL,
  valor       NUMERIC(10,2),
  unidad      TEXT,
  nota        TEXT,
  user_id     BIGINT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_mant_registros_equipo ON mant_registros (equipo_id, created_at) WHERE deleted_at IS NULL;
