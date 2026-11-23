-- 166 · Lista de precios del POS por sucursal (Diego 23/11/2026: «uso de MaxiRest la lista 1 para
-- San Justo y la 2 para Ramos»). Cada sucursal (app_branches) dice qué lista del POS cobra; la
-- columna Precio de Artículos y el costo % salen de esa lista según el chip de sucursal, y con
-- «Todas» se pondera por las unidades vendidas en cada una.
CREATE TABLE IF NOT EXISTS branch_price_list (
  business_id  BIGINT NOT NULL,
  branch_id    BIGINT NOT NULL REFERENCES app_branches(id) ON DELETE CASCADE,
  list_number  SMALLINT NOT NULL CHECK (list_number BETWEEN 1 AND 4),
  updated_by   BIGINT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, branch_id)
);

-- Container FC (204), confirmado con las ventas de noviembre: San Justo (15) cobra la Lista 1 y
-- Ramos (16, principal) la Lista 2. Solo si todavía no hay nada elegido.
INSERT INTO branch_price_list (business_id, branch_id, list_number)
SELECT 204, b.id, CASE b.id WHEN 15 THEN 1 ELSE 2 END
  FROM app_branches b WHERE b.business_id = 204 AND b.id IN (15, 16)
ON CONFLICT (business_id, branch_id) DO NOTHING;
