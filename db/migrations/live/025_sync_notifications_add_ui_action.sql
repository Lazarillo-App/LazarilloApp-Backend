-- ✅ SUPERSET del CHECK actual + agrega ui_action
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
    'ui_action',
    'error'
  ));
