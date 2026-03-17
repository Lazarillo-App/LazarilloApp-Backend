-- migrations/add_purchase_batches_and_config.sql
-- Ejecutar una vez para agregar soporte de lotes de compras y configuración por negocio

-- 1. Agregar batch_id a la tabla purchases (si no existe)
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS batch_id TEXT;

-- 2. Crear índice para buscar por lote
CREATE INDEX IF NOT EXISTS idx_purchases_batch_id ON purchases(batch_id);
CREATE INDEX IF NOT EXISTS idx_purchases_business_batch ON purchases(business_id, batch_id);

-- 3. Poblar batch_ids faltantes usando updated_at (created_at no existe en esta tabla)
UPDATE purchases
SET batch_id = TO_CHAR(updated_at, 'YYYYMMDD-HH24MISS') || '-legacy'
WHERE batch_id IS NULL;