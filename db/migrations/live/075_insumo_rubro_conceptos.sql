-- Rubros de insumo con más de un concepto de caja posible (Diego 07/11/2026): ej. Vajilla → Reposición
-- (702 Vajilla M) o Ítem nuevo (514 Vajilla I). Al cargar se pregunta; lo que quede sin elegir va a
-- Sin rubro «se decide en cada compra». Es de la organización (los insumos viven en el negocio principal).
CREATE TABLE IF NOT EXISTS insumo_rubro_conceptos (
  id              SERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  rubro_codigo    TEXT NOT NULL,
  etiqueta        TEXT NOT NULL,
  concepto        TEXT NOT NULL,
  orden           INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT insumo_rubro_conceptos_uk UNIQUE (organization_id, rubro_codigo, etiqueta)
);
CREATE INDEX IF NOT EXISTS insumo_rubro_conceptos_org_rubro ON insumo_rubro_conceptos (organization_id, rubro_codigo);
