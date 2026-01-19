-- ============================================================================
-- MIGRACIÓN: Funciones y vistas para sistema de subnegocios
-- ============================================================================
-- Versión defensiva que verifica existencia de columnas antes de usarlas
-- ============================================================================

-- 0. Limpiar funciones existentes para permitir cambios en parámetros
-- ============================================================================
DROP FUNCTION IF EXISTS get_business_hierarchy(INTEGER);
DROP FUNCTION IF EXISTS get_all_subnegocios(INTEGER);
DROP FUNCTION IF EXISTS count_articulos_including_subnegocios(INTEGER);
DROP FUNCTION IF EXISTS count_insumos_by_business(INTEGER);
DROP FUNCTION IF EXISTS count_insumos_including_subnegocios(INTEGER);
DROP FUNCTION IF EXISTS get_insumos_with_subnegocios(INTEGER);

-- 0.5 Crear columna parent_id si no existe
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'app_businesses' 
      AND column_name = 'parent_id'
  ) THEN
    ALTER TABLE app_businesses ADD COLUMN parent_id INTEGER;
    -- Agregar FK si la columna se creó
    ALTER TABLE app_businesses 
      ADD CONSTRAINT fk_business_parent 
      FOREIGN KEY (parent_id) REFERENCES app_businesses(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 1. Crear índices de forma segura
-- ============================================================================
DO $$
BEGIN
  -- Índice en app_businesses.parent_id
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'app_businesses' AND column_name = 'parent_id'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE tablename = 'app_businesses' AND indexname = 'idx_app_businesses_parent_id'
    ) THEN
      CREATE INDEX idx_app_businesses_parent_id ON app_businesses(parent_id);
    END IF;
  END IF;
  
  -- Índice en insumos.business_id
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'insumos' AND column_name = 'business_id'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE tablename = 'insumos' AND indexname = 'idx_insumos_business_id'
    ) THEN
      CREATE INDEX idx_insumos_business_id ON insumos(business_id);
    END IF;
  END IF;
  
  -- Índice en app_articles.business_id
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'app_articles' AND column_name = 'business_id'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE tablename = 'app_articles' AND indexname = 'idx_app_articles_business_id'
    ) THEN
      CREATE INDEX idx_app_articles_business_id ON app_articles(business_id);
    END IF;
  END IF;
END $$;

-- 2. Función para obtener jerarquía de negocios
-- ============================================================================
CREATE OR REPLACE FUNCTION get_business_hierarchy(business_id_param INTEGER)
RETURNS TABLE (
  id BIGINT,
  name TEXT,
  slug TEXT,
  level INTEGER,
  path TEXT
) AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE business_tree AS (
    SELECT 
      b.id,
      b.name,
      b.slug,
      b.parent_id,
      0 as level,
      b.name::TEXT as path
    FROM app_businesses b
    WHERE b.id = business_id_param
    
    UNION ALL
    
    SELECT 
      b.id,
      b.name,
      b.slug,
      b.parent_id,
      bt.level + 1,
      bt.path || ' → ' || b.name
    FROM app_businesses b
    INNER JOIN business_tree bt ON b.parent_id = bt.id
  )
  SELECT bt.id, bt.name, bt.slug, bt.level, bt.path
  FROM business_tree bt
  ORDER BY bt.level, bt.name;
END;
$$ LANGUAGE plpgsql;

-- 3. Función para obtener todos los subnegocios
-- ============================================================================
CREATE OR REPLACE FUNCTION get_all_subnegocios(parent_id_param INTEGER)
RETURNS TABLE (
  id BIGINT,
  name TEXT,
  slug TEXT,
  nivel INTEGER
) AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE subnegocio_tree AS (
    SELECT 
      b.id,
      b.name,
      b.slug,
      1 as nivel
    FROM app_businesses b
    WHERE b.parent_id = parent_id_param
    
    UNION ALL
    
    SELECT 
      b.id,
      b.name,
      b.slug,
      st.nivel + 1
    FROM app_businesses b
    INNER JOIN subnegocio_tree st ON b.parent_id = st.id
  )
  SELECT st.id, st.name, st.slug, st.nivel FROM subnegocio_tree st
  ORDER BY st.nivel, st.name;
END;
$$ LANGUAGE plpgsql;

-- 4. Función para contar artículos incluyendo subnegocios
-- ============================================================================
CREATE OR REPLACE FUNCTION count_articulos_including_subnegocios(business_id_param INTEGER)
RETURNS INTEGER AS $$
DECLARE
  total INTEGER;
BEGIN
  WITH all_business_ids AS (
    SELECT sub.id FROM get_all_subnegocios(business_id_param) sub
    UNION
    SELECT business_id_param::BIGINT
  )
  SELECT COUNT(*)::INTEGER
  INTO total
  FROM app_articles a
  WHERE a.business_id IN (SELECT ab.id::INTEGER FROM all_business_ids ab);
  
  RETURN COALESCE(total, 0);
END;
$$ LANGUAGE plpgsql;

-- 5. Función para contar insumos por negocio
-- ============================================================================
CREATE OR REPLACE FUNCTION count_insumos_by_business(business_id_param INTEGER)
RETURNS INTEGER AS $$
DECLARE
  total INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER
  INTO total
  FROM insumos
  WHERE business_id = business_id_param;
  
  RETURN COALESCE(total, 0);
END;
$$ LANGUAGE plpgsql;

-- 6. Función para contar insumos incluyendo subnegocios
-- ============================================================================
CREATE OR REPLACE FUNCTION count_insumos_including_subnegocios(business_id_param INTEGER)
RETURNS INTEGER AS $$
DECLARE
  total INTEGER;
BEGIN
  WITH all_business_ids AS (
    SELECT sub.id FROM get_all_subnegocios(business_id_param) sub
    UNION
    SELECT business_id_param::BIGINT
  )
  SELECT COUNT(*)::INTEGER
  INTO total
  FROM insumos i
  WHERE i.business_id IN (SELECT ab.id::INTEGER FROM all_business_ids ab);
  
  RETURN COALESCE(total, 0);
END;
$$ LANGUAGE plpgsql;

-- 7. Función para obtener insumos con subnegocios
-- ============================================================================
CREATE OR REPLACE FUNCTION get_insumos_with_subnegocios(business_id_param INTEGER)
RETURNS TABLE (
  id INTEGER,
  nombre TEXT,
  codigo_mostrar TEXT,
  business_id INTEGER,
  business_name TEXT
) AS $$
BEGIN
  RETURN QUERY
  WITH all_businesses AS (
    SELECT sub.id FROM get_all_subnegocios(business_id_param) sub
    UNION
    SELECT business_id_param::BIGINT
  )
  SELECT 
    i.id,
    i.nombre::TEXT,
    i.codigo_mostrar,
    i.business_id,
    b.name
  FROM insumos i
  INNER JOIN app_businesses b ON i.business_id = b.id
  WHERE i.business_id IN (SELECT ab.id::INTEGER FROM all_businesses ab)
  ORDER BY b.name, i.nombre;
END;
$$ LANGUAGE plpgsql;

-- 8. Vista para negocios con información de padre
-- ============================================================================
DROP VIEW IF EXISTS v_businesses_with_parent CASCADE;
CREATE VIEW v_businesses_with_parent AS
SELECT 
  b.id,
  b.name,
  b.slug,
  b.parent_id,
  p.name as parent_name,
  p.slug as parent_slug,
  CASE 
    WHEN b.parent_id IS NULL THEN 'principal'
    ELSE 'subnegocio'
  END as tipo,
  b.created_at,
  b.updated_at
FROM app_businesses b
LEFT JOIN app_businesses p ON b.parent_id = p.id;

-- 9. Vista para insumos con su negocio
-- ============================================================================
DROP VIEW IF EXISTS v_insumos_with_business CASCADE;
CREATE VIEW v_insumos_with_business AS
SELECT 
  i.*,
  b.name as business_name,
  b.slug as business_slug,
  b.parent_id as business_parent_id,
  CASE 
    WHEN b.parent_id IS NULL THEN 'principal'
    ELSE 'subnegocio'
  END as business_type
FROM insumos i
LEFT JOIN app_businesses b ON i.business_id = b.id;

-- 10. Vista para artículos con su negocio
-- ============================================================================
DROP VIEW IF EXISTS v_articles_with_business CASCADE;
CREATE VIEW v_articles_with_business AS
SELECT 
  a.*,
  b.name as business_name,
  b.slug as business_slug,
  b.parent_id as business_parent_id,
  CASE 
    WHEN b.parent_id IS NULL THEN 'principal'
    ELSE 'subnegocio'
  END as business_type
FROM app_articles a
LEFT JOIN app_businesses b ON a.business_id = b.id;