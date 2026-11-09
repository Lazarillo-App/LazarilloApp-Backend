-- Lo cargado en el Panel (gestion_facturas_movil) era único por negocio + comprobante + proveedor:
-- dos tickets con el mismo número del mismo proveedor, de distinta fecha, no se podían guardar
-- (bug heredado de lazarillo_gestion). Ahora la fecha también es parte de la clave. Las facturas
-- A/B/C/NC igual quedan únicas por número: eso lo controla la carga (yaExiste) antes de guardar.
-- Idempotente: corre en cada arranque.
ALTER TABLE gestion_facturas_movil DROP CONSTRAINT IF EXISTS gestion_facturas_movil_key;
CREATE UNIQUE INDEX IF NOT EXISTS gestion_facturas_movil_cpb_fecha_key
  ON gestion_facturas_movil (business_id, comprobante, codigo, fecha);
