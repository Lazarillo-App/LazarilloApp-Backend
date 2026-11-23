-- 19/11/2026 — Aprobaciones: una marca de revisión hecha sobre un ingrediente
-- DENTRO de una receta queda sobre esa receta (payload_after.revisar = [insumos]).
-- La marca #80 (CHEDDAR PASTA ELABORADO, Container Bar) se hizo desde la receta
-- de Brioche Ribswich antes de este cambio y quedó sobre el insumo: se pasa a la
-- receta de origen. Idempotente: solo toca la fila si sigue como quedó.
UPDATE receta_proposals
   SET article_id = -1284,
       insumo_id = NULL,
       receta_id = (SELECT id FROM recetas WHERE business_id = 147 AND article_id = -1284 AND active = TRUE ORDER BY id DESC LIMIT 1),
       payload_after = '{"revisar":[262353]}'::jsonb,
       updated_at = NOW()
 WHERE id = 80 AND business_id = 147 AND insumo_id = 262353 AND article_id IS NULL
   AND status = 'in_revision' AND payload_after = '{}'::jsonb;
