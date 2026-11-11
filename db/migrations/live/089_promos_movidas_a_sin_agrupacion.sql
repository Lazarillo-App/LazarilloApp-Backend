-- 089 · Promos que la lógica vieja MOVIÓ a "Promociones" vuelven a "Sin Agrupación"
-- (Diego 11/11/2026: pasar un artículo a promoción ya no lo mueve; Promociones es un resumen).
-- Se mueven solo los artículos de app_articles_ids de cada "Promociones" (los que llegaron por
-- el switch Producto→Promoción); lo que vino agrupado desde MaxiRest no se toca.
-- Corre UNA sola vez: las migraciones .sql corren en cada arranque, así que la tabla de
-- respaldo hace de marca — si ya existe, no hace nada.
DO $$
DECLARE
  r record;
  ids bigint[];
BEGIN
  IF to_regclass('public._respaldo_agrup_promos_20261111') IS NOT NULL THEN
    RETURN;
  END IF;

  CREATE TABLE public._respaldo_agrup_promos_20261111 AS
    SELECT * FROM agrupaciones WHERE id IN (1099, 676, 1082, 1077, 1160, 982);

  -- (Promociones, Sin Agrupación) por negocio: Container Bar 147, Comercio 210, Palermo suites 190
  FOR r IN SELECT * FROM (VALUES (1099, 676), (1082, 1077), (1160, 982)) v(promo, sinag) LOOP
    SELECT array_agg(x::bigint) INTO ids
      FROM agrupaciones g, jsonb_array_elements_text(COALESCE(g.app_articles_ids, '[]'::jsonb)) x
     WHERE g.id = r.promo;
    CONTINUE WHEN ids IS NULL;

    UPDATE agrupaciones
       SET articulos = (
             SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
               FROM jsonb_array_elements(COALESCE(articulos, '[]'::jsonb)) e
              WHERE (COALESCE(e->>'id', CASE WHEN jsonb_typeof(e) = 'number' THEN e::text END)::bigint = ANY(ids)) IS NOT TRUE
           ),
           app_articles_ids = '[]'::jsonb,
           updated_at = NOW()
     WHERE id = r.promo;

    UPDATE agrupaciones
       SET articulos = COALESCE(articulos, '[]'::jsonb) || (
             SELECT COALESCE(jsonb_agg(jsonb_build_object('id', i)), '[]'::jsonb)
               FROM unnest(ids) i
              WHERE NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(articulos, '[]'::jsonb)) e
                 WHERE COALESCE(e->>'id', CASE WHEN jsonb_typeof(e) = 'number' THEN e::text END)::bigint = i
              )
           ),
           updated_at = NOW()
     WHERE id = r.sinag;
  END LOOP;
END $$;
