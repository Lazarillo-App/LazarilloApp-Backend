-- 103_demo_requests.sql (13/11/2026)
-- Pedidos de demo de la página pública ("Quiero verlo en mi restaurante" / "Pedí una demo").
-- Se guardan siempre, aunque falle el mail, para no perder ningún contacto. Idempotente.
CREATE TABLE IF NOT EXISTS demo_requests (
  id           BIGSERIAL PRIMARY KEY,
  nombre       TEXT NOT NULL,
  restaurante  TEXT NOT NULL,
  contacto     TEXT NOT NULL,
  prioridad    TEXT,
  mensaje      TEXT,
  ip           TEXT,
  navegador    TEXT,
  mail_enviado BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_demo_requests_created ON demo_requests (created_at DESC);
