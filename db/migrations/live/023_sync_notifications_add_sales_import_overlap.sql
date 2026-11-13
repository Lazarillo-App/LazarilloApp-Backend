-- db/migrations/live/023_sync_notifications_add_sales_import_overlap.sql
-- Neutralizada el 12/11/2026. Esta migración corre en CADA arranque: pasaba a 'error' todo aviso
-- con un tipo fuera de su lista (discontinuar, mover, agrupaciones…) y volvía a poner un CHECK
-- que rechazaba los tipos nuevos (altas/bajas de artículos e insumos, RRHH, Recetas), así que
-- esos avisos nunca se guardaban. Los tipos válidos ahora los controla el código
-- (ALLOWED_TYPES en services/notificationService.js). Ver 102_sync_notifications_sin_check.sql.
ALTER TABLE sync_notifications
  DROP CONSTRAINT IF EXISTS sync_notifications_type_check;
