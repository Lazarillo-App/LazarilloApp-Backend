-- 168 · Rubros y conceptos de caja discontinuados (Diego 20/11/2026: «si quiero apagar un rubro para que
-- no aparezca más?»; 24/11: la palabra es «discontinuar»). Se discontinúa para toda la organización
-- (business_id NULL) o solo en algunos negocios. No se borra nada: deja de ofrecerse al cargar.
CREATE TABLE IF NOT EXISTS gestion_conceptos_discontinuados (
  id              BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  tipo            TEXT NOT NULL CHECK (tipo IN ('rubro', 'concepto')),
  codigo          TEXT NOT NULL,
  business_id     BIGINT,
  "creadoPor"     TEXT,
  "creadoEn"      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gestion_conceptos_discontinuados_uq
  ON gestion_conceptos_discontinuados (organization_id, tipo, codigo, COALESCE(business_id, 0));
