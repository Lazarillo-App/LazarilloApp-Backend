-- db/migrations/live/024_sync_notifications_fix_check.sql

UPDATE sync_notifications
SET type = 'sync_insumos'
WHERE type = 'sync_articles'
  AND COALESCE(metadata->>'scope','') = 'insumos';

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
