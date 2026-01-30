-- migrations/017_sync_notifications.sql
-- ✅ Idempotente + soporta sync_insumos + corrige legacy data

CREATE TABLE IF NOT EXISTS sync_notifications (
  id              BIGSERIAL PRIMARY KEY,
  business_id     INTEGER NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,

  -- ✅ default neutral (evita defaults viejos que después chocan con constraints)
  type            TEXT NOT NULL DEFAULT 'error',

  title           TEXT NOT NULL,
  message         TEXT,

  metadata        JSONB DEFAULT '{}'::jsonb,

  read            BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ✅ Si tu tabla ya existe pero venía con DEFAULT viejo, lo ajustamos sin romper
ALTER TABLE sync_notifications
  ALTER COLUMN type SET DEFAULT 'error';

-- =========================================================
-- ✅ DATA FIX (opcional pero recomendado para no romper CHECK)
-- =========================================================

-- Si antes guardaste insumos como sync_articles con scope=insumos, normalizalo:
UPDATE sync_notifications
SET type = 'sync_insumos'
WHERE type = 'sync_articles'
  AND COALESCE(metadata->>'scope','') = 'insumos';

-- (Opcional) Si en algún momento existió "sync_insumo" singular, también:
UPDATE sync_notifications
SET type = 'sync_insumos'
WHERE type = 'sync_insumo';

-- =========================================================
-- ✅ CHECK CONSTRAINT (incluye sync_insumos)
-- =========================================================

ALTER TABLE sync_notifications
  DROP CONSTRAINT IF EXISTS sync_notifications_type_check;

ALTER TABLE sync_notifications
  ADD CONSTRAINT sync_notifications_type_check
  CHECK (type IN (
    'sync_insumos',
    'sync_articles',
    'sync_sales',
    'auto_assign',
    'sales_import_overlap',
    'error'
  ));

-- índices idempotentes
CREATE INDEX IF NOT EXISTS idx_sync_notif_user_read
  ON sync_notifications(user_id, read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_notif_business
  ON sync_notifications(business_id, created_at DESC);

COMMENT ON TABLE sync_notifications IS 'Notificaciones de sincronizaciones y eventos del sistema';
