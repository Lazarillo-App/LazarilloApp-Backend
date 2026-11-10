-- Chat de Anthony "Que lo haga Lazarillo" (pedido de la usuaria, 2026-11-10): el usuario elige
-- opciones de un menú guiado y al final escribe un mensaje que le llega al equipo por mail.
-- soporte_config: UNA fila con la configuración editable desde el panel de super-admin (mails que
-- reciben, WhatsApp de contacto y el menú/respuestas de Anthony). soporte_mensajes: lo que se mandó.
-- Idempotente: corre en cada arranque.
CREATE TABLE IF NOT EXISTS soporte_config (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  config      JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT
);

INSERT INTO soporte_config (id, config) VALUES (1, $json${
  "emails": ["lazarillo.app2025@gmail.com"],
  "whatsapp": "5491163989934",
  "chat": {
    "saludo": "¡Hola! Soy Anthony. ¿En qué te puedo ayudar?",
    "despedida": "¡Listo! Tu mensaje le llegó al equipo de Lazarillo. Te vamos a contactar pronto.",
    "opciones": [
      { "id": "armar", "texto": "Quiero que armen mi negocio por mí",
        "pregunta": { "texto": "¿Qué tenés para arrancar?", "opciones": ["Archivos de artículos o insumos", "Mi POS", "Nada todavía"] },
        "pedido": "Contanos un poco de tu negocio y cuándo te podemos contactar." },
      { "id": "pos", "texto": "Necesito ayuda para conectar mi POS",
        "pregunta": { "texto": "¿Qué POS usás?", "libre": true },
        "pedido": "¿Qué datos querés traer (artículos, ventas, compras, insumos)?" },
      { "id": "tecnico", "texto": "Tengo un problema técnico",
        "pregunta": { "texto": "¿En qué parte?", "opciones": ["Artículos", "Recetas", "Insumos", "Panel de gestión", "Otra"] },
        "pedido": "Contanos qué pasó." },
      { "id": "duda", "texto": "Tengo una duda sobre cómo usar Lazarillo", "pedido": "¿Cuál es tu duda?" },
      { "id": "otra", "texto": "Otra cosa", "pedido": "Escribinos tu mensaje." }
    ]
  }
}$json$::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS soporte_mensajes (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT,
  business_id  BIGINT,
  opcion       TEXT,
  respuesta    TEXT,
  mensaje      TEXT NOT NULL,
  contexto     JSONB,
  enviado      BOOLEAN NOT NULL DEFAULT false,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS soporte_mensajes_user_idx ON soporte_mensajes (user_id, created_at DESC);
