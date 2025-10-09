-- 022_auth_app_users.sql

-- Tabla base
CREATE TABLE IF NOT EXISTS app_users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active_business_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Campos de estado/rol (si faltan)
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS role  TEXT NOT NULL DEFAULT 'owner',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- Campos de reset password (si faltan)
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS reset_token_hash TEXT NULL,
  ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMP NULL;

-- Índice case-insensitive por email
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'app_users_email_lower_idx'
  ) THEN
    CREATE UNIQUE INDEX app_users_email_lower_idx
      ON app_users (lower(email));
  END IF;
END$$;
