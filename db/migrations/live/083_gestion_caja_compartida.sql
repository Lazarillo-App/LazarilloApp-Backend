-- Caja compartida (08/11/2026): en Ramos Mejía, Bar (147) y Canchas (204, principal) usan UNA sola
-- caja. Cada fila es un lugar (negocio + sucursal; NULL = la principal) de un grupo. Los arqueos del
-- grupo se guardan en el lugar "ancla" y la diferencia de caja de cualquiera de ellos suma los
-- movimientos de todos (como la vista del local en gestion). La configuración la carga un script.
CREATE TABLE IF NOT EXISTS gestion_caja_compartida (
  id          BIGSERIAL PRIMARY KEY,
  grupo       TEXT NOT NULL,
  business_id BIGINT NOT NULL,
  branch_id   BIGINT,
  ancla       BOOLEAN NOT NULL DEFAULT false,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Un lugar está en un solo grupo; un solo ancla por grupo.
CREATE UNIQUE INDEX IF NOT EXISTS gestion_caja_compartida_lugar
  ON gestion_caja_compartida (business_id, branch_id) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX IF NOT EXISTS gestion_caja_compartida_ancla
  ON gestion_caja_compartida (grupo) WHERE ancla;
