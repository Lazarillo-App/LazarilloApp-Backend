-- 087 · Costo de cada insumo POR LOCAL (Diego 10/11/2026).
-- Los insumos viven en el negocio principal (un solo precio_ref para toda la organización),
-- pero cada local compra a su precio (ej. el Bar con factura A, FC con factura Z). Acá se guarda
-- el precio que corresponde a cada local según SUS compras y la config de costeo; las recetas de
-- ese local se costean con este precio. Si el local no compró el insumo, se usa precio_ref.
CREATE TABLE IF NOT EXISTS insumo_costos_local (
  insumo_id   INT     NOT NULL,
  business_id INT     NOT NULL,
  precio      NUMERIC NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (insumo_id, business_id)
);
CREATE INDEX IF NOT EXISTS insumo_costos_local_biz ON insumo_costos_local (business_id);
