-- ============================================================================
-- MIGRACIÓN: Funciones y vistas para sistema de subnegocios
-- ============================================================================
-- Versión FINAL adaptada a tu estructura exacta:
-- - app_businesses.id = BIGINT
-- - app_businesses.parent_id = INTEGER  
-- - insumos.business_id = INTEGER
-- - app_articles.business_id = INTEGER
-- ============================================================================

-- 1. Crear índices (si no existen)
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_app_businesses_parent_id ON app_businesses(parent_id);
CREATE INDEX IF NOT EXISTS idx_insumos_business_id ON insumos(business_id);
CREATE INDEX IF NOT EXISTS idx_app_articles_business_id ON app_articles(business_id);

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
    -- Caso base: el negocio solicitado
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
    
    -- Caso recursivo: hijos
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
  SELECT id, name, slug, level, path
  FROM business_tree
  ORDER BY level, name;
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
    -- Caso base: subnegocios directos
    SELECT 
      b.id,
      b.name,
      b.slug,
      1 as nivel
    FROM app_businesses b
    WHERE b.parent_id = parent_id_param
    
    UNION ALL
    
    -- Caso recursivo: sub-subnegocios
    SELECT 
      b.id,
      b.name,
      b.slug,
      st.nivel + 1
    FROM app_businesses b
    INNER JOIN subnegocio_tree st ON b.parent_id = st.id
  )
  SELECT * FROM subnegocio_tree
  ORDER BY nivel, name;
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
    SELECT id FROM get_all_subnegocios(business_id_param)
    UNION
    SELECT business_id_param::BIGINT
  )
  SELECT COUNT(*)::INTEGER
  INTO total
  FROM app_articles a
  WHERE a.business_id IN (SELECT id::INTEGER FROM all_business_ids);
  
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
    SELECT id FROM get_all_subnegocios(business_id_param)
    UNION
    SELECT business_id_param::BIGINT
  )
  SELECT COUNT(*)::INTEGER
  INTO total
  FROM insumos i
  WHERE i.business_id IN (SELECT id::INTEGER FROM all_business_ids);
  
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
    SELECT id FROM get_all_subnegocios(business_id_param)
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
  WHERE i.business_id IN (SELECT id::INTEGER FROM all_businesses)
  ORDER BY b.name, i.nombre;
END;
$$ LANGUAGE plpgsql;

-- 8. Vista para negocios con información de padre
-- ============================================================================
CREATE OR REPLACE VIEW v_businesses_with_parent AS
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
CREATE OR REPLACE VIEW v_insumos_with_business AS
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
CREATE OR REPLACE VIEW v_articles_with_business AS
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

-- ============================================================================
-- COMENTARIOS
-- ============================================================================
COMMENT ON COLUMN app_businesses.parent_id IS 
'ID del negocio padre. NULL para negocios principales, valor para subnegocios';

COMMENT ON COLUMN insumos.business_id IS 
'ID del negocio o subnegocio al que pertenece el insumo';

COMMENT ON COLUMN app_articles.business_id IS 
'ID del negocio o subnegocio al que pertenece el artículo';

COMMENT ON FUNCTION get_business_hierarchy IS 
'Obtiene la jerarquía completa de un negocio (padres e hijos)';

COMMENT ON FUNCTION get_all_subnegocios IS 
'Obtiene todos los subnegocios recursivamente de un negocio principal';

COMMENT ON FUNCTION count_articulos_including_subnegocios IS 
'Cuenta artículos del negocio y todos sus subnegocios';

COMMENT ON FUNCTION count_insumos_by_business IS 
'Cuenta insumos de un negocio específico (sin subnegocios)';

COMMENT ON FUNCTION count_insumos_including_subnegocios IS 
'Cuenta insumos del negocio y todos sus subnegocios';

COMMENT ON FUNCTION get_insumos_with_subnegocios IS 
'Obtiene insumos del negocio y todos sus subnegocios';

COMMENT ON VIEW v_businesses_with_parent IS 
'Vista que muestra negocios con información de su padre';

COMMENT ON VIEW v_insumos_with_business IS 
'Vista que muestra insumos con información de su negocio';

COMMENT ON VIEW v_articles_with_business IS 
'Vista que muestra artículos con información de su negocio';

-- ============================================================================
-- VERIFICACIÓN Y PRUEBAS
-- ============================================================================

-- Ver negocios con jerarquía
SELECT 
  id,
  name,
  tipo,
  parent_name
FROM v_businesses_with_parent 
ORDER BY parent_id NULLS FIRST, name;

-- Ver distribución de insumos por negocio
SELECT 
  b.name as negocio,
  COALESCE(COUNT(i.id), 0) as total_insumos
FROM app_businesses b
LEFT JOIN insumos i ON i.business_id = b.id
GROUP BY b.id, b.name
ORDER BY b.parent_id NULLS FIRST, b.name
LIMIT 20;

-- Ver distribución de artículos por negocio
SELECT 
  b.name as negocio,
  COALESCE(COUNT(a.id), 0) as total_articulos
FROM app_businesses b
LEFT JOIN app_articles a ON a.business_id = b.id
GROUP BY b.id, b.name
ORDER BY b.parent_id NULLS FIRST, b.name
LIMIT 20;

-- Probar funciones (usa el ID de uno de tus negocios)
-- SELECT * FROM get_business_hierarchy(31);
-- SELECT * FROM get_all_subnegocios(31);
-- SELECT count_articulos_including_subnegocios(31);
-- SELECT count_insumos_including_subnegocios(31);

COMMIT;
