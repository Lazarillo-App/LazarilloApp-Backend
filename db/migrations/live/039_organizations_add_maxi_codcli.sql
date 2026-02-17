-- 039_organizations_add_maxi_codcli.sql
-- Fix: la columna maxi_codcli puede no existir en instancias
-- donde organizations se creó antes de la migración 034 revisada.
-- ADD COLUMN IF NOT EXISTS es idempotente, no rompe si ya existe.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS maxi_codcli TEXT;

-- Índice defensivo (IF NOT EXISTS evita error si ya existía)
CREATE INDEX IF NOT EXISTS idx_organizations_maxi_codcli
  ON organizations(maxi_codcli)
  WHERE maxi_codcli IS NOT NULL;