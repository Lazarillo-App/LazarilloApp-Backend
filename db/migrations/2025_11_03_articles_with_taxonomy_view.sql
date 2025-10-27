CREATE OR REPLACE VIEW vw_articles_with_taxonomy AS
SELECT
  a.id,
  a.name        AS nombre,
  a.price       AS precio,
  NULL::numeric AS costo,           -- ajustá si tenés columna/props
  c.nombre      AS categoria,
  s.nombre      AS subrubro
FROM app_articles a
JOIN categorias c ON c.id = a.categoria_id
JOIN subrubros s ON s.id = a.subrubro_id;
