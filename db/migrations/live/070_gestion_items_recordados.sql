-- IVA e impuestos internos recordados por insumo / concepto (Diego 06/11/2026): la próxima carga
-- los propone igual que el último precio. ii = por unidad base del insumo. Solo agrega una tabla.
CREATE TABLE IF NOT EXISTS gestion_items_recordados (
  organization_id BIGINT NOT NULL,
  tipo TEXT NOT NULL,
  codigo TEXT NOT NULL,
  alic NUMERIC(6,2),
  ii NUMERIC(14,4),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, tipo, codigo)
);
