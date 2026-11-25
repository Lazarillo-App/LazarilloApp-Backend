-- 173: «Usar esta merma» desde Producción (usuaria 25/11/2026). El jefe de cocina (y dueño/admin) guarda la
-- merma medida en la cocina como merma de limpieza del insumo, sin aprobación; dueño y admin la pueden
-- deshacer. Cada uso guarda cómo estaba la merma del insumo antes (`antes`), para volver exacto.
-- Ver services/produccionMermaUso.js. Idempotente y aditiva.
CREATE TABLE IF NOT EXISTS produccion_mermas_uso (
  id              BIGSERIAL PRIMARY KEY,
  business_id     BIGINT       NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  insumo_id       BIGINT       NOT NULL,
  insumo_merma_id BIGINT,                 -- la fila de insumo_mermas que se tocó
  registro_id     BIGINT,                 -- produccion_mermas medida (si vino de la lista)
  antes           JSONB        NOT NULL,  -- { existia, nombre, peso_inicial, peso_final, es_default, pct }
  despues         JSONB        NOT NULL,  -- { nombre, peso_inicial, peso_final, pct }
  user_id         BIGINT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deshecho_at     TIMESTAMPTZ,
  deshecho_por    BIGINT
);
CREATE INDEX IF NOT EXISTS ix_produccion_mermas_uso_biz ON produccion_mermas_uso (business_id, created_at DESC);
