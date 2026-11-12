-- Neutralizada el 12/11/2026: ver 023 y 102. Los tipos válidos los controla el código.
ALTER TABLE sync_notifications
  DROP CONSTRAINT IF EXISTS sync_notifications_type_check;
