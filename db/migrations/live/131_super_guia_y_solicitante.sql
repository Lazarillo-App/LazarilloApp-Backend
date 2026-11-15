-- 131: guía del proyecto y «quién lo pidió» en los pendientes (Diego 14/11/2026).
-- Pendientes de desarrollo = guía única de Diego, Mairene y las sugerencias de los clientes.
-- Idempotente: corre en cada arranque.
ALTER TABLE super_tareas ADD COLUMN IF NOT EXISTS solicitante_id BIGINT;
-- Lo cargado hasta hoy: quien lo pidió es quien lo creó, salvo el listado inicial que armó Claude
-- (usuario 51) con lo que pidió Diego (usuario 2) en los chats.
UPDATE super_tareas SET solicitante_id = CASE WHEN creado_por = 51 THEN 2 ELSE creado_por END
 WHERE solicitante_id IS NULL;

-- Qué queremos lograr y cómo trabajamos: un solo texto, lo editan los super usuarios.
CREATE TABLE IF NOT EXISTS super_guia (
  id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  texto       TEXT NOT NULL DEFAULT '',
  updated_by  BIGINT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO super_guia (id) VALUES (1) ON CONFLICT DO NOTHING;
