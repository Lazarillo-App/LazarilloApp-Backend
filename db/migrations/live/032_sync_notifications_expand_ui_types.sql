-- 032_sync_notifications_expand_ui_types.sql
-- Neutralizada el 12/11/2026: ver 023 y 102. Los tipos válidos los controla el código
-- (ALLOWED_TYPES en services/notificationService.js); el CHECK fijo rechazaba los tipos nuevos.
ALTER TABLE sync_notifications
  DROP CONSTRAINT IF EXISTS sync_notifications_type_check;
