-- 095: vinculación automática de recetas idénticas (Diego 12/11/2026).
-- `auto`: el artículo entró solo al grupo por tener la misma receta (chip «auto»).
-- `auto_vinculo_off`: el artículo se desvinculó a mano → no se vuelve a vincular solo.
ALTER TABLE article_link_members ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE recetas ADD COLUMN IF NOT EXISTS auto_vinculo_off BOOLEAN NOT NULL DEFAULT FALSE;
