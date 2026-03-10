-- 045_recetas_maxi_sync.sql
-- Adapta receta_items para soportar sync desde MaxiRest
-- y carga manual por CSV.
--
-- Cambios:
--   receta_items:
--     - insumo_id   → ahora apunta a insumos.id (antes: maxi_supplies.id)
--     - codigo_maxi_insumo → el insCode de MaxiRest, para resolver luego si el insumo no existe
--     - nombre_insumo_maxi → el insName de MaxiRest, fallback de display
--   recetas:
--     - origen → 'maxi' | 'csv' | 'manual'

-- ── recetas: agregar columna origen ──────────────────────────────────────────
ALTER TABLE recetas
  ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'manual';

-- ── receta_items: cambio de supply_id → insumo_id ────────────────────────────
-- Nota: si supply_id ya tiene datos, los dejamos como está (no los borramos)
-- La nueva columna insumo_id es nullable — se resuelve en el sync.

ALTER TABLE receta_items
  ADD COLUMN IF NOT EXISTS insumo_id            BIGINT   REFERENCES insumos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS codigo_maxi_insumo   TEXT,
  ADD COLUMN IF NOT EXISTS nombre_insumo_maxi   TEXT;

-- Índices útiles
CREATE INDEX IF NOT EXISTS idx_receta_items_insumo_id
  ON receta_items (insumo_id);

CREATE INDEX IF NOT EXISTS idx_receta_items_codigo_maxi
  ON receta_items (codigo_maxi_insumo);

CREATE INDEX IF NOT EXISTS idx_recetas_article_biz
  ON recetas (article_id, business_id);

-- ── Re-resolver insumo_id desde supply_id existente (migración de datos) ─────
-- Si ya había items con supply_id (de maxi_supplies), intentar cruzar por codigo
-- Esto es best-effort — si no matchea, queda null
UPDATE receta_items ri
SET
  codigo_maxi_insumo = ms.codigo::text,
  nombre_insumo_maxi = ms.nombre,
  insumo_id = (
    SELECT i.id FROM insumos i
    WHERE i.codigo_maxi = ms.codigo::text
      AND i.business_id = (SELECT business_id FROM recetas WHERE id = ri.receta_id LIMIT 1)
    LIMIT 1
  )
FROM maxi_supplies ms
WHERE ri.supply_id = ms.id
  AND ri.insumo_id IS NULL
  AND ri.codigo_maxi_insumo IS NULL;