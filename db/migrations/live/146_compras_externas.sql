-- 146: compras que llegan de otro sistema (POS, por ahora Fudo) entran al Panel como una factura más
-- de Lazarillo: editable, con concepto de caja y con sus costos (usuaria + Diego, 17/11/2026). No es
-- algo de Fudo: cualquier conector entrega sus compras y pasan por services/comprasExternas.js.
-- Idempotente.

-- Concepto de caja del proveedor: para los gastos sin insumo (alquiler, luz, contador) que llegan de
-- un sistema. Con insumo, manda el concepto del rubro del insumo (insumo_rubros.cpto_caja_lazarillo).
ALTER TABLE gestion_proveedores ADD COLUMN IF NOT EXISTS "conceptoCodigo" text;

-- Qué compra de cada sistema ya entró (y en qué factura del Panel). Se trae una vez: lo que después se
-- edite en Lazarillo manda. estado: 'cargada' | 'repetida' (ya estaba en el Panel / ARCA, no se sumó).
CREATE TABLE IF NOT EXISTS compras_externas (
  business_id   integer     NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  origen        text        NOT NULL,          -- 'fudo', …
  externo_id    text        NOT NULL,          -- id de la compra en ese sistema
  estado        text        NOT NULL DEFAULT 'cargada',
  row_id        text,                          -- gestion_compras."rowId" de la factura creada
  proveedor_id  integer,                       -- gestion_proveedores.id
  fecha         date,
  total         numeric(14,2),
  creado_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, origen, externo_id)
);
