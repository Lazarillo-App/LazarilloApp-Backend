-- db/migrations/live/024_sync_notifications_fix_check.sql
-- ✅ NO-OP: el CHECK se gestiona en 023_sync_notifications_add_sales_import_overlap.sql

UPDATE sync_notifications
SET type = 'sync_insumos'
WHERE type = 'sync_articles'
  AND COALESCE(metadata->>'scope','') = 'insumos';

