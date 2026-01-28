-- migrations/017_sync_notifications.sql

CREATE TABLE IF NOT EXISTS sync_notifications (
  id              BIGSERIAL PRIMARY KEY,
  business_id     INTEGER NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  
  type            TEXT NOT NULL DEFAULT 'sync_articles', -- 'sync_articles', 'sync_sales', 'auto_assign'
  title           TEXT NOT NULL,
  message         TEXT,
  
  metadata        JSONB DEFAULT '{}'::jsonb, -- info extra (IDs asignados, grupos, etc)
  
  read            BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT sync_notifications_type_check 
    ALTER TABLE sync_notifications
  DROP CONSTRAINT IF EXISTS sync_notifications_type_check;

ALTER TABLE sync_notifications
  ADD CONSTRAINT sync_notifications_type_check
    CHECK (type IN ('sync_articles', 'sync_sales', 'auto_assign', 'sales_import_overlap', 'error'));

);

CREATE INDEX idx_sync_notif_user_read ON sync_notifications(user_id, read, created_at DESC);
CREATE INDEX idx_sync_notif_business ON sync_notifications(business_id, created_at DESC);

COMMENT ON TABLE sync_notifications IS 'Notificaciones de sincronizaciones y eventos del sistema';