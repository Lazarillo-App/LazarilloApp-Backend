-- 148: facturas que se repiten todos los meses (Diego 18/11/2026). Lazarillo detecta los clientes
-- solo (proyección de ventas) y sugiere en qué meses facturan; acá queda lo que el usuario corrigió,
-- por PDV: meses prendidos/apagados, monto esperado fijo, o un cliente agregado / sacado a mano.
-- Idempotente: corre en cada arranque.
CREATE TABLE IF NOT EXISTS gestion_clientes_recurrentes (
  id              BIGSERIAL PRIMARY KEY,
  business_id     BIGINT      NOT NULL,
  branch_id       BIGINT,                 -- NULL = la principal
  cliente         TEXT        NOT NULL,   -- nombre normalizado (minúsculas, sin espacios de más)
  nombre          TEXT,                   -- como se muestra
  meses           BOOLEAN[],              -- 12 valores (ene..dic); NULL = los que sugiere Lazarillo
  esperado        NUMERIC,                -- NULL = lo del último mes que facturó
  activo          BOOLEAN     NOT NULL DEFAULT true,  -- false = «no es recurrente»
  actualizado_por BIGINT,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gestion_clientes_recurrentes_uk
  ON gestion_clientes_recurrentes (business_id, COALESCE(branch_id, 0), cliente);
