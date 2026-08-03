-- 060_dashboard_store.sql
-- Almacén key-value para el Dashboard de Resultados Mensuales.
-- Reemplaza el window.storage del artefacto. Scopeado por negocio (business_id),
-- igual que el resto de Lazarillo: cada negocio/subnegocio tiene su propio dashboard.
--
-- El dashboard maneja internamente sus propias "pestañas de negocio"
-- (Restaurante Ramos, FC Ramos, etc.) — esas viven como datos DENTRO de este store,
-- bajo el business_id de Lazarillo que actúa como contenedor.

CREATE TABLE IF NOT EXISTS dashboard_store (
  business_id  BIGINT       NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  store_key    TEXT         NOT NULL,          -- ej. "movstock:tab_config", "movstock:own_resto_file_12"
  value        TEXT         NOT NULL,          -- payload serializado (JSON string, o base64 gzip que arma el front)
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, store_key)
);

-- Listado por prefijo (el front hace storage.list("movstock:")): índice para el LIKE 'prefijo%'
CREATE INDEX IF NOT EXISTS idx_dashboard_store_biz_key
  ON dashboard_store (business_id, store_key text_pattern_ops);
