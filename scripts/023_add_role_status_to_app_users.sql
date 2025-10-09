-- 023_add_role_status_to_app_users.sql
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS role   TEXT NOT NULL DEFAULT 'owner',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- Por si todavía no existe el índice de email case-insensitive
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'app_users_email_lower_idx'
  ) THEN
    CREATE UNIQUE INDEX app_users_email_lower_idx ON app_users (lower(email));
  END IF;
END$$;
