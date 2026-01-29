-- db/migrations/live/024_sync_change_sets_add_sales_import_scope.sql

DO $$
BEGIN
  -- si no existe la tabla, salimos sin romper el deploy
  IF to_regclass('public.sync_change_sets') IS NULL THEN
    RAISE NOTICE 'skip 024: table sync_change_sets does not exist';
    RETURN;
  END IF;

  -- recreamos el check con el scope nuevo
  ALTER TABLE public.sync_change_sets
    DROP CONSTRAINT IF EXISTS sync_change_sets_scope_check;

  ALTER TABLE public.sync_change_sets
    ADD CONSTRAINT sync_change_sets_scope_check
    CHECK (scope IN (
      'articles',
      'insumos',
      'sales_import'  -- ✅ scope nuevo
    ));
END $$;
