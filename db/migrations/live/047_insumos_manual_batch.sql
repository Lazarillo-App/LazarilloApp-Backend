-- migrations/live/047_insumos_manual_batch.sql
-- Soporte para carga manual de insumos con lotes y reconciliación posterior

-- 1. Batch de subida manual (para poder listar y eliminar lotes)
ALTER TABLE insumos ADD COLUMN IF NOT EXISTS upload_batch_id TEXT;

-- 2. Flag sin equivalencia externa (sin codigo_maxi de Maxi)
ALTER TABLE insumos ADD COLUMN IF NOT EXISTS sin_equivalencia BOOLEAN DEFAULT FALSE;

-- 3. Nombre normalizado para reconciliación fuzzy
ALTER TABLE insumos ADD COLUMN IF NOT EXISTS nombre_normalizado TEXT 
  GENERATED ALWAYS AS (
    lower(
      trim(
        regexp_replace(
          unaccent(coalesce(nombre, '')),
          '[^a-z0-9\s]', '', 'g'
        )
      )
    )
  ) STORED;

-- 4. Índices
CREATE INDEX IF NOT EXISTS idx_insumos_batch        ON insumos(business_id, upload_batch_id) WHERE upload_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_insumos_sin_equiv     ON insumos(business_id, sin_equivalencia) WHERE sin_equivalencia = TRUE;
CREATE INDEX IF NOT EXISTS idx_insumos_nombre_norm   ON insumos(business_id, nombre_normalizado);

-- 5. Marcar insumos manuales existentes sin codigo_maxi como sin equivalencia
UPDATE insumos
SET sin_equivalencia = TRUE
WHERE origen IN ('manual', 'csv')
  AND (codigo_maxi IS NULL OR codigo_maxi = '');