-- 102_sync_notifications_sin_check.sql (12/11/2026)
-- Sin CHECK fijo sobre sync_notifications.type: los tipos válidos los controla el código
-- (ALLOWED_TYPES en services/notificationService.js). Antes la 023 corría en cada arranque y
-- pasaba a 'error' los avisos de discontinuar, mover y agrupaciones, y el CHECK de la 032
-- rechazaba los avisos nuevos (artículos, insumos, RRHH, Recetas).
ALTER TABLE sync_notifications
  DROP CONSTRAINT IF EXISTS sync_notifications_type_check;

-- Devuelve su tipo a los avisos que la 023 había pasado a 'error' (el tipo real quedó en
-- metadata.kind). Los errores de verdad no tienen kind y no se tocan. Idempotente.
UPDATE sync_notifications
   SET type = metadata->>'kind'
 WHERE type = 'error'
   AND metadata->>'kind' IN ('discontinue', 'move', 'group_create', 'group_rename', 'group_delete',
                             'group_move_division', 'group_favorite', 'group_unfavorite');
