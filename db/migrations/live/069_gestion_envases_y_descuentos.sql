-- 069_gestion_envases_y_descuentos.sql
-- Carga de facturas (pedido de Diego, 06/11/2026):
--  · Envases de compra de cada insumo editables en Lazarillo (X6, Pack 12…). Los de MaxiRest siguen
--    viniendo del maestro; acá se guardan los nuevos y las correcciones (mismo nombre = pisa al de
--    MaxiRest; borrado = no se ofrece más). La importación no toca esta tabla.
--  · Último descuento de cada proveedor × insumo, para sugerirlo en la próxima carga.
-- Tablas nuevas, idempotente. Para volver atrás: DROP TABLE de las dos.
CREATE TABLE IF NOT EXISTS gestion_envases_insumo (
  organization_id BIGINT NOT NULL,
  insumo_codigo   TEXT   NOT NULL,
  envase          TEXT   NOT NULL,
  factor          NUMERIC(14,4) NOT NULL,
  borrado         BOOLEAN NOT NULL DEFAULT false,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gestion_envases_insumo_key
  ON gestion_envases_insumo (organization_id, insumo_codigo, UPPER(envase));

CREATE TABLE IF NOT EXISTS gestion_descuentos_recordados (
  organization_id BIGINT  NOT NULL,
  proveedor_id    INTEGER NOT NULL,
  insumo_codigo   TEXT    NOT NULL,
  tipo            TEXT    NOT NULL,           -- '%' | 'u' ($ por unidad) | 't' ($ sobre el total)
  valor           NUMERIC(14,4) NOT NULL,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, proveedor_id, insumo_codigo)
);
