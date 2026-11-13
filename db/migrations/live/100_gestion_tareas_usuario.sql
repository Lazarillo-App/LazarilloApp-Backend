-- Tareas tipo to-do en el cajón de Notas del Panel (Diego 12/11/2026): de cada usuario en cada negocio,
-- como las notas. "creadaEn" = fecha de creación; "hechaEn" = fecha de baja (al tildarla). NULL = pendiente.
CREATE TABLE IF NOT EXISTS gestion_tareas_usuario (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  business_id BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  texto       TEXT NOT NULL,
  "creadaEn"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "hechaEn"   TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS gestion_tareas_usuario_dueno_idx ON gestion_tareas_usuario (user_id, business_id, "hechaEn");
