-- Habilitar extensión para UUID si no está
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Usuarios
CREATE TABLE IF NOT EXISTS app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  phone TEXT,
  active_business_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Negocios (locales)
CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tax_id TEXT,
  timezone TEXT DEFAULT 'America/Argentina/Buenos_Aires',
  currency TEXT DEFAULT 'ARS',
  url_slug TEXT UNIQUE,
  primary_color TEXT,
  secondary_color TEXT,
  logo_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Relación usuarios <-> negocios (roles)
CREATE TABLE IF NOT EXISTS user_business_roles (
  user_id UUID REFERENCES app_users(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','staff')),
  PRIMARY KEY (user_id, business_id)
);

-- Credenciales de Maxi por negocio (encriptadas)
CREATE TABLE IF NOT EXISTS maxi_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID UNIQUE NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  pass_enc TEXT NOT NULL,
  cod_cli_enc TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- active_business_id FK suave (no cascada)
ALTER TABLE app_users
  ADD CONSTRAINT fk_active_business
  FOREIGN KEY (active_business_id) REFERENCES businesses(id) ON DELETE SET NULL;
