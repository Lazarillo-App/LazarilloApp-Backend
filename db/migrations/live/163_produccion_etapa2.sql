-- 163: Producción · etapa 2 (usuaria 21/11/2026): mise en place, mermas, desperdicios y etiquetas.
-- Todo lo que sale de lo comprado sin pasar por una venta queda registrado para el stock futuro
-- (compra + producción − venta − consumos). Idempotente: corre en cada arranque.

-- Mise en place: lo que se deja armado en cada plaza al empezar el turno (sal, aceite, salsas…).
-- Casi nunca cambia: es la plantilla de la plaza. Una tarea de tipo 'mise_en_place' copia la
-- plantilla al empezar y, al terminarla, eso cuenta como consumo.
CREATE TABLE IF NOT EXISTS produccion_mise (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT       NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  plaza_id    INT          NOT NULL,
  insumo_id   BIGINT,
  nombre      TEXT         NOT NULL,
  cantidad    NUMERIC(14,4) NOT NULL,
  unidad      TEXT,
  orden       INT          NOT NULL DEFAULT 0,
  updated_by  BIGINT,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_produccion_mise_plaza ON produccion_mise (business_id, plaza_id);

-- Merma medida en la cocina (como la hoja «merma» de la planilla): peso bruto que entró y peso
-- limpio que quedó. Se compara con la merma configurada del insumo (insumo_mermas).
CREATE TABLE IF NOT EXISTS produccion_mermas (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT       NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  insumo_id   BIGINT,
  nombre      TEXT         NOT NULL,
  bruto       NUMERIC(14,4) NOT NULL,
  neto        NUMERIC(14,4) NOT NULL,
  unidad      TEXT,
  nota        TEXT,
  tarea_id    BIGINT,
  user_id     BIGINT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_produccion_mermas_biz ON produccion_mermas (business_id, created_at) WHERE deleted_at IS NULL;

-- Desperdicios: lo que se tira (vencido, se pasó de cocción, dañado, se cayó…).
-- tipo: insumo | elaborado | otro.
CREATE TABLE IF NOT EXISTS produccion_desperdicios (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT       NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  tipo        TEXT         NOT NULL DEFAULT 'insumo',
  insumo_id   BIGINT,
  nombre      TEXT         NOT NULL,
  cantidad    NUMERIC(14,4) NOT NULL,
  unidad      TEXT,
  motivo      TEXT         NOT NULL,
  comentario  TEXT,
  plaza_id    INT,
  user_id     BIGINT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_produccion_desperdicios_biz ON produccion_desperdicios (business_id, created_at) WHERE deleted_at IS NULL;

-- Etiquetas: días de vida útil de cada elaborado (vencimiento = fecha de elaboración + días).
ALTER TABLE produccion_elaborados ADD COLUMN IF NOT EXISTS dias_vida INT;
