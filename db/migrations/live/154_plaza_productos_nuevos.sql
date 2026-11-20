-- 154 · Productos nuevos en una plaza (Diego 20/11/2026: «los productos nuevos los debería destacar en una
-- plaza así quien opera se da cuenta rápido»).
-- plaza_fichas.agregado_at: cuándo el producto entró a la plaza por primera vez. La ficha queda aunque se
-- quite el producto, así que quitarlo y volver a ponerlo (Deshacer) no lo marca como nuevo otra vez.
-- Los que ya estaban quedan en NULL (no son nuevos); los que se agregan desde ahora toman NOW().
ALTER TABLE plaza_fichas ADD COLUMN IF NOT EXISTS agregado_at TIMESTAMPTZ;
ALTER TABLE plaza_fichas ALTER COLUMN agregado_at SET DEFAULT NOW();
