-- 075 · RRHH: nómina compartida entre negocios de la misma cartera (Diego, 07/11/2026).
-- Un negocio sin nómina propia puede usar la de otro (vinculada, no copia):
-- las altas, bajas y ediciones se ven en los dos; cada uno arma su cronograma.
-- origen_business_id siempre es la nómina "raíz" (nunca una cadena de vínculos).
CREATE TABLE IF NOT EXISTS rrhh_nomina_vinculo (
  business_id         BIGINT PRIMARY KEY REFERENCES app_businesses(id) ON DELETE CASCADE,
  origen_business_id  BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (business_id <> origen_business_id)
);
CREATE INDEX IF NOT EXISTS ix_rrhh_nomina_vinculo_origen ON rrhh_nomina_vinculo(origen_business_id);
