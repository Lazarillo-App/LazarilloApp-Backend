-- 020_admin_core.sql
-- Roles en users + soft delete + auditoría + relación user<->business (multi-tenant)
-- Ajusta nombres de tablas según tu esquema actual si difiere.

-- Users: agrega columnas role y status si no existen
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'owner',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP NULL;

-- Opcional: índice para búsquedas por email/nombre
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_name ON users (name);

-- Tabla de auditoría
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  meta JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC);

-- Relación users<->businesses con rol por negocio (si no la tienes)
CREATE TABLE IF NOT EXISTS user_business_roles (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner', -- owner|manager|viewer
  UNIQUE(user_id, business_id)
);

-- Vista rápida para KPIs (opcional): usuarios activos últimos 30 días
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_users_active_30d AS
SELECT u.id, u.email, u.name
FROM users u
WHERE u.status = 'active'
  AND (u.last_login_at IS NULL OR u.last_login_at >= NOW() - INTERVAL '30 days');

-- Refresh manual (luego puedes cron)
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_users_active_30d;
