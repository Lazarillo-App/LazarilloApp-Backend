-- migrations/017_sync_notifications_safe.sql
-- ✅ Migración SEGURA que maneja datos legacy

-- PASO 1: Crear tabla si no existe (sin constraints todavía)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_name = 'sync_notifications'
  ) THEN
    CREATE TABLE sync_notifications (
      id              BIGSERIAL PRIMARY KEY,
      business_id     INTEGER NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      type            VARCHAR(50) NOT NULL,
      title           VARCHAR(255) NOT NULL,
      message         TEXT,
      metadata        JSONB DEFAULT '{}'::jsonb,
      read            BOOLEAN DEFAULT false,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    
    RAISE NOTICE 'Tabla sync_notifications creada';
  ELSE
    RAISE NOTICE 'Tabla sync_notifications ya existe';
  END IF;
END $$;

-- PASO 2: Agregar columna metadata si no existe
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'sync_notifications' 
    AND column_name = 'metadata'
  ) THEN
    ALTER TABLE sync_notifications ADD COLUMN metadata JSONB DEFAULT '{}'::jsonb;
    RAISE NOTICE 'Columna metadata agregada';
  ELSE
    RAISE NOTICE 'Columna metadata ya existe';
  END IF;
END $$;

-- PASO 3: ELIMINAR constraint anterior si existe
DO $$ 
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'sync_notifications_type_check'
    AND conrelid = 'sync_notifications'::regclass
  ) THEN
    ALTER TABLE sync_notifications DROP CONSTRAINT sync_notifications_type_check;
    RAISE NOTICE 'Constraint anterior eliminado';
  ELSE
    RAISE NOTICE 'No había constraint anterior';
  END IF;
END $$;

-- PASO 4: LIMPIAR datos que no cumplen con los nuevos tipos
-- Convertir tipos no reconocidos a 'ui_action'
UPDATE sync_notifications
SET type = 'ui_action'
WHERE type NOT IN (
  'sync_insumos',
  'sync_articles',
  'sync_sales',
  'auto_assign',
  'sales_import_overlap',
  'ui_action',
  'error',
  'group_create',
  'group_rename',
  'group_delete',
  'group_move_division',
  'group_favorite',
  'group_unfavorite',
  'discontinue',
  'move'
);

-- PASO 5: AHORA agregar el constraint actualizado
ALTER TABLE sync_notifications
ADD CONSTRAINT sync_notifications_type_check
CHECK (type IN (
  'sync_insumos',
  'sync_articles',
  'sync_sales',
  'auto_assign',
  'sales_import_overlap',
  'ui_action',
  'error',
  'group_create',
  'group_rename',
  'group_delete',
  'group_move_division',
  'group_favorite',
  'group_unfavorite',
  'discontinue',
  'move'
));

-- PASO 6: Crear índices si no existen
CREATE INDEX IF NOT EXISTS idx_sync_notifications_user_business
ON sync_notifications(user_id, business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_notifications_business_unread
ON sync_notifications(business_id, read, created_at DESC)
WHERE read = false;

CREATE INDEX IF NOT EXISTS idx_sync_notifications_type
ON sync_notifications(type, created_at DESC);

-- ✅ Migración completada exitosamente