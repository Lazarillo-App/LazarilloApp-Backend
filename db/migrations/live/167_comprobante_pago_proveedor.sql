-- 167 · Comprobante de pago adjunto (Diego 23/11/2026: «adjuntar el comprobante de pago y que solo me
-- tome los datos»). El archivo (PDF o foto de la transferencia) queda guardado en la base, por negocio,
-- y el pago a proveedor apunta a él para abrirlo después desde la cuenta corriente.
CREATE TABLE IF NOT EXISTS gestion_comprobantes_pago (
  id              BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  business_id     BIGINT NOT NULL,
  nombre          TEXT NOT NULL,
  mime            TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  datos           BYTEA NOT NULL,
  leido           JSONB,
  "creadoPor"     TEXT,
  "creadoEn"      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gestion_comprobantes_pago_business_idx ON gestion_comprobantes_pago (business_id);
ALTER TABLE gestion_pagos_proveedor ADD COLUMN IF NOT EXISTS "comprobanteId" BIGINT;
