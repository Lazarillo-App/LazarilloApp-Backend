-- 036_recetas.sql
-- Tablas para recetas de artículos.
-- Una receta pertenece a un artículo dentro de un sub-negocio específico.
-- El mismo artículo puede tener receta diferente en cada sub-negocio
-- (mismo insumo, distinto costo y % de margen de venta).
-- Los insumos se referencian desde maxi_supplies (el catálogo de Maxi).

-- 1) Tabla principal de recetas
CREATE TABLE IF NOT EXISTS recetas (
  id               BIGSERIAL PRIMARY KEY,

  -- Artículo + sub-negocio (clave compuesta única)
  article_id       INTEGER NOT NULL,  -- id en app_articles
  business_id      BIGINT  NOT NULL
    REFERENCES app_businesses(id) ON DELETE CASCADE,

  -- Datos de la receta
  nombre           TEXT,              -- ej: "Pizza Mozzarella Clásica"
  descripcion      TEXT,
  porciones        INTEGER NOT NULL DEFAULT 1,

  -- % de margen de venta definido por ESTE negocio
  -- Ej: 30 = 30% → precio sugerido = costo / (1 - 0.30)
  porcentaje_venta NUMERIC(5,2) NOT NULL DEFAULT 0,

  -- Costo total calculado: suma de (cantidad * costo_unitario) de cada item
  -- Se recalcula y persiste en cada save para consulta rápida
  costo_total      NUMERIC(14,4) NOT NULL DEFAULT 0,

  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Una sola receta por artículo por negocio
  UNIQUE (article_id, business_id)
);

CREATE INDEX IF NOT EXISTS ix_recetas_article  ON recetas(article_id);
CREATE INDEX IF NOT EXISTS ix_recetas_business ON recetas(business_id);
CREATE INDEX IF NOT EXISTS ix_recetas_art_biz  ON recetas(article_id, business_id);

-- 2) Items de cada receta (un ítem = un insumo con cantidad y costo)
CREATE TABLE IF NOT EXISTS receta_items (
  id             BIGSERIAL PRIMARY KEY,
  receta_id      BIGINT NOT NULL
    REFERENCES recetas(id) ON DELETE CASCADE,

  -- Insumo del catálogo global de Maxi
  supply_id      BIGINT NOT NULL
    REFERENCES maxi_supplies(id) ON DELETE RESTRICT,

  -- Cantidad usada en esta receta y su unidad
  cantidad       NUMERIC(12,4) NOT NULL DEFAULT 0,
  unidad         TEXT,
  -- Valores comunes: 'gr', 'kg', 'ml', 'lt', 'u', 'porciones'

  -- ★ Costo que paga ESTE negocio por este insumo
  -- No depende de maxi_supplies.precio, lo define el usuario
  -- por negocio en el momento de armar la receta
  costo_unitario NUMERIC(14,4) NOT NULL DEFAULT 0,

  -- Notas del ítem (ej: "bien cocido", "sin sal")
  notas          TEXT,

  -- Orden de presentación en el modal
  orden          INTEGER NOT NULL DEFAULT 0,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_receta_items_receta ON receta_items(receta_id);
CREATE INDEX IF NOT EXISTS ix_receta_items_supply  ON receta_items(supply_id);

-- 3) Triggers updated_at
DROP TRIGGER IF EXISTS trg_recetas_updated ON recetas;
CREATE TRIGGER trg_recetas_updated
  BEFORE UPDATE ON recetas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_receta_items_updated ON receta_items;
CREATE TRIGGER trg_receta_items_updated
  BEFORE UPDATE ON receta_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();