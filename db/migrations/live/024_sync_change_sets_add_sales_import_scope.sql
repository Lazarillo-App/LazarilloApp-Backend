-- db/migrations/live/024_sync_notifications_fix_check.sql
-- ✅ Debe ser SUPERSET de todo lo que ya existe en prod

-- defensivo: limpiar espacios en type (evita 'ui_action ' y similares)
UPDATE sync_notifications
SET type = btrim(type)
WHERE type <> btrim(type);

-- legacy fix (lo tuyo)
UPDATE sync_notifications
SET type = 'sync_insumos'
WHERE type = 'sync_articles'
  AND COALESCE(metadata->>'scope','') = 'insumos';

-- por si existió singular
UPDATE sync_notifications
SET type = 'sync_insumos'
WHERE type = 'sync_insumo';

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
    'ui_action',   -- ✅ CLAVE
    'error'
  ));
