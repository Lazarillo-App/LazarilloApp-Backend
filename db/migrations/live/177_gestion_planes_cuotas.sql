-- 177 · Pago de facturas de proveedor en cuotas (usuaria 27/11/2026).
-- Al pagar, «En cuotas»: se elige la cantidad, la 1ª se registra como un pago normal y el resto queda en el
-- plan con su vencimiento (mismo día de los meses siguientes). Con «recordar», el día que vence aparece un
-- aviso flotante en pantalla con «Marcar como paga», que registra ese pago contra las mismas facturas.
-- cuotas: [{ n, importe, vence: 'YYYY-MM-DD', pagoId: int|null, pagadaEn: iso|null, pagadaPor: text|null }]
-- facturas: [{ pdvId, comprobante }]. Idempotente.
CREATE TABLE IF NOT EXISTS gestion_planes_cuotas (
  id               BIGSERIAL PRIMARY KEY,
  organization_id  BIGINT NOT NULL,
  business_id      BIGINT NOT NULL,
  "codPro"         TEXT NOT NULL,
  proveedor        TEXT,
  facturas         JSONB NOT NULL DEFAULT '[]'::jsonb,
  total            NUMERIC(14,2) NOT NULL,
  cantidad         INTEGER NOT NULL,
  cuotas           JSONB NOT NULL DEFAULT '[]'::jsonb,
  medio            TEXT,
  "pdvPagaId"      INTEGER,
  recordar         BOOLEAN NOT NULL DEFAULT TRUE,
  estado           TEXT NOT NULL DEFAULT 'activo',   -- activo | terminado | cancelado
  "creadoPor"      TEXT,
  "creadoEn"       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gestion_planes_cuotas_biz_idx ON gestion_planes_cuotas (business_id, estado);
