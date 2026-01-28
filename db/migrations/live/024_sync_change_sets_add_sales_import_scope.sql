-- db/migrations/live/024_sync_change_sets_add_sales_import_scope.sql

ALTER TABLE sync_change_sets
  DROP CONSTRAINT IF EXISTS sync_change_sets_scope_check;

ALTER TABLE sync_change_sets
  ADD CONSTRAINT sync_change_sets_scope_check
  CHECK (scope IN (
    'articles',
    'insumos',
    'prices',
    'rubros',
    'sales_import',
    'all'
  ));
