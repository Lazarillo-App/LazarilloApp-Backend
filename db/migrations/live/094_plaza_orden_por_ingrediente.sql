-- 094 · Plazas: el orden de armado es PROPIO de la plaza (Diego 11/11/2026).
-- Antes cada renglón se identificaba con el id del renglón de la receta (r:<id>), pero al guardar
-- una receta se borran y recrean sus renglones (ids nuevos) → se perdía el orden de la plaza y
-- volvía el de la receta (que se ordena por costo). Ahora el renglón se identifica por el
-- INGREDIENTE (i:<insumo> / a:<artículo> / n:<nombre>), que no cambia al guardar la receta.
-- 1) Pasa las fichas existentes de r:<id> al ingrediente.
-- 2) Congela el orden actual para los productos de plaza que todavía no tenían ficha.
-- Idempotente.

UPDATE plaza_fichas f
   SET layout = f.layout || jsonb_build_object(
     'orden', (SELECT COALESCE(jsonb_agg(COALESCE(m.ref, e.k) ORDER BY e.n), '[]'::jsonb)
                 FROM jsonb_array_elements_text(COALESCE(f.layout->'orden', '[]'::jsonb)) WITH ORDINALITY AS e(k, n)
                 LEFT JOIN LATERAL (
                   SELECT CASE WHEN ri.insumo_id IS NOT NULL THEN 'i:' || ri.insumo_id
                               WHEN ri.article_ref_id IS NOT NULL THEN 'a:' || ri.article_ref_id END AS ref
                     FROM receta_items ri
                    WHERE ri.id = CASE WHEN e.k ~ '^r:[0-9]+$' THEN substring(e.k from 3)::bigint END) m ON TRUE),
     'ocultos', (SELECT COALESCE(jsonb_agg(COALESCE(m.ref, e.k) ORDER BY e.n), '[]'::jsonb)
                 FROM jsonb_array_elements_text(COALESCE(f.layout->'ocultos', '[]'::jsonb)) WITH ORDINALITY AS e(k, n)
                 LEFT JOIN LATERAL (
                   SELECT CASE WHEN ri.insumo_id IS NOT NULL THEN 'i:' || ri.insumo_id
                               WHEN ri.article_ref_id IS NOT NULL THEN 'a:' || ri.article_ref_id END AS ref
                     FROM receta_items ri
                    WHERE ri.id = CASE WHEN e.k ~ '^r:[0-9]+$' THEN substring(e.k from 3)::bigint END) m ON TRUE))
 WHERE f.layout::text LIKE '%"r:%';

INSERT INTO plaza_fichas (plaza_id, article_id, layout, updated_at)
SELECT pp.plaza_id, pp.article_id,
       jsonb_build_object(
         'orden', COALESCE((
           SELECT jsonb_agg(CASE WHEN ri.insumo_id IS NOT NULL THEN 'i:' || ri.insumo_id
                                 WHEN ri.article_ref_id IS NOT NULL THEN 'a:' || ri.article_ref_id
                                 ELSE 'n:' || lower(COALESCE(ri.nombre_insumo_maxi, 'Ingrediente')) END
                            ORDER BY ri.orden, ri.id)
             FROM recetas r JOIN receta_items ri ON ri.receta_id = r.id
            WHERE r.business_id = p.business_id AND r.article_id = pp.article_id AND COALESCE(r.active, TRUE)), '[]'::jsonb),
         'ocultos', '[]'::jsonb, 'extras', '[]'::jsonb),
       NOW()
  FROM plaza_productos pp JOIN plazas p ON p.id = pp.plaza_id
ON CONFLICT (plaza_id, article_id) DO NOTHING;
