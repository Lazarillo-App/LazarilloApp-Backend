-- 120: pedidos de los clientes (chat de Anthony con captura) + ajustes a medida (usuaria 13/11/2026).
-- Número alto a propósito para no chocar con las migraciones de Diego (testing va por la 100).
-- Idempotente: corre en cada arranque.

-- Cada mensaje del chat pasa a ser un pedido con estado, tipo, alcance y captura.
ALTER TABLE soporte_mensajes ADD COLUMN IF NOT EXISTS tipo          TEXT;          -- problema | pedido | consulta
ALTER TABLE soporte_mensajes ADD COLUMN IF NOT EXISTS estado        TEXT NOT NULL DEFAULT 'nuevo';
  -- nuevo | revision | contactar | desarrollo | resuelto | descartado
ALTER TABLE soporte_mensajes ADD COLUMN IF NOT EXISTS alcance       TEXT;          -- negocio | usuario | global
ALTER TABLE soporte_mensajes ADD COLUMN IF NOT EXISTS asignado_a    BIGINT;
ALTER TABLE soporte_mensajes ADD COLUMN IF NOT EXISTS captura_url   TEXT;
ALTER TABLE soporte_mensajes ADD COLUMN IF NOT EXISTS pantalla      TEXT;          -- ruta donde estaba el cliente
ALTER TABLE soporte_mensajes ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE soporte_mensajes ADD COLUMN IF NOT EXISTS cerrado_at    TIMESTAMPTZ;
-- Última vez que el cliente vio las respuestas (para el globito de "respuesta nueva").
ALTER TABLE soporte_mensajes ADD COLUMN IF NOT EXISTS visto_cliente_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS soporte_mensajes_estado_idx ON soporte_mensajes (estado, created_at DESC);

-- Hilo de cada pedido: respuestas del equipo, del cliente y notas internas (el cliente no las ve).
CREATE TABLE IF NOT EXISTS soporte_respuestas (
  id          BIGSERIAL PRIMARY KEY,
  mensaje_id  BIGINT NOT NULL REFERENCES soporte_mensajes(id) ON DELETE CASCADE,
  autor_id    BIGINT,
  de_equipo   BOOLEAN NOT NULL DEFAULT true,
  interna     BOOLEAN NOT NULL DEFAULT false,
  texto       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS soporte_respuestas_mensaje_idx ON soporte_respuestas (mensaje_id, created_at);

-- Ajustes a medida: una clave con un valor, para todos (global) o para una organización,
-- un negocio o un usuario puntual. Gana el más específico: usuario > negocio > organización > global.
CREATE TABLE IF NOT EXISTS ajustes_alcance (
  id           BIGSERIAL PRIMARY KEY,
  clave        TEXT NOT NULL,
  alcance      TEXT NOT NULL CHECK (alcance IN ('global', 'organizacion', 'negocio', 'usuario')),
  scope_id     BIGINT,                    -- NULL solo en global
  valor        JSONB NOT NULL DEFAULT 'true'::jsonb,
  activo       BOOLEAN NOT NULL DEFAULT true,
  nota         TEXT,
  solicitud_id BIGINT REFERENCES soporte_mensajes(id) ON DELETE SET NULL,
  created_by   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((alcance = 'global') = (scope_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ajustes_alcance_unico ON ajustes_alcance (clave, alcance, COALESCE(scope_id, 0));

-- Opción nueva del chat: pedir un cambio (con captura). Se agrega antes de "Otra cosa" solo si
-- todavía no está, sin tocar lo que se haya editado desde el panel.
UPDATE soporte_config SET config = jsonb_set(config, '{chat,opciones}', (
    SELECT jsonb_agg(e ORDER BY orden) FROM (
      SELECT e, CASE WHEN e->>'id' = 'otra' THEN 2 ELSE 0 END + (n::numeric / 1000) AS orden
        FROM jsonb_array_elements(config->'chat'->'opciones') WITH ORDINALITY AS t(e, n)
      UNION ALL
      SELECT $json${ "id": "cambio", "texto": "Quiero pedir un cambio o algo nuevo", "captura": true, "tipo": "pedido",
                     "pedido": "Sacá una captura de la pantalla que querés cambiar y contanos qué necesitás." }$json$::jsonb, 1
    ) x))
 WHERE id = 1 AND NOT (config->'chat'->'opciones') @> '[{"id":"cambio"}]'::jsonb;

-- "Tengo un problema técnico" también pide captura (si nadie la cambió desde el panel).
UPDATE soporte_config SET config = jsonb_set(config, '{chat,opciones}', (
    SELECT jsonb_agg(CASE WHEN e->>'id' = 'tecnico' AND NOT (e ? 'captura')
                          THEN e || '{"captura": true, "tipo": "problema"}'::jsonb ELSE e END ORDER BY n)
      FROM jsonb_array_elements(config->'chat'->'opciones') WITH ORDINALITY AS t(e, n)))
 WHERE id = 1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(config->'chat'->'opciones') e
                           WHERE e->>'id' = 'tecnico' AND NOT (e ? 'captura'));
