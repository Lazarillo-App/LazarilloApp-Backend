-- 171: Mantenimiento de equipos · historial completo de eventos y fotos en fallas/registros (usuaria 25/11/2026).
-- Idempotente y aditiva: solo CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS e índices IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS mant_eventos (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT        NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  equipo_id   BIGINT        NOT NULL REFERENCES mant_equipos(id) ON DELETE CASCADE,
  tipo        TEXT          NOT NULL, -- equipo_alta | equipo_edit | equipo_estado | equipo_baja | plan_alta | plan_edit | plan_baja | orden_reprogramada | orden_cancelada | orden_reabierta
  detalle     JSONB         NOT NULL DEFAULT '{}'::jsonb,
  user_id     BIGINT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_mant_eventos_equipo ON mant_eventos (business_id, equipo_id, created_at DESC);

ALTER TABLE mant_ordenes ADD COLUMN IF NOT EXISTS foto_url TEXT;
ALTER TABLE mant_ordenes ADD COLUMN IF NOT EXISTS foto_public_id TEXT;

ALTER TABLE mant_registros ADD COLUMN IF NOT EXISTS foto_url TEXT;
ALTER TABLE mant_registros ADD COLUMN IF NOT EXISTS foto_public_id TEXT;
