-- 032_sync_notifications_expand_ui_types.sql
-- ✅ Superset: incluye TODO lo que ya existe + nuevos tipos UI

ALTER TABLE sync_notifications
  DROP CONSTRAINT IF EXISTS sync_notifications_type_check;

ALTER TABLE sync_notifications
  ADD CONSTRAINT sync_notifications_type_check
  CHECK (type = ANY (ARRAY[
    'sync_insumos'::text,
    'sync_articles'::text,
    'sync_sales'::text,
    'auto_assign'::text,
    'sales_import_overlap'::text,
    'ui_action'::text,
    'error'::text,

    -- ✅ nuevos tipos UI (permitidos por el backend)
    'group_create'::text,
    'group_rename'::text,
    'group_delete'::text,
    'group_move_division'::text,
    'group_favorite'::text,
    'group_unfavorite'::text,
    'discontinue'::text,
    'move'::text
  ]));
