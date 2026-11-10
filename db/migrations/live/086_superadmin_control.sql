-- 086: control de super-admins (pedido de la usuaria, 2026-11-10).
-- Solo la cuenta de control (lazarillo.app2025@gmail.com) puede dar o quitar el rol app_admin
-- desde el panel, y cada cambio pide un código de 6 dígitos que llega SOLO a ese mail.
-- Acá se guarda el código (hasheado) atado a la acción pedida: un código sirve para esa acción
-- y nada más, vence a los 10 minutos y admite 5 intentos.
-- Idempotente: corre en cada arranque.
CREATE TABLE IF NOT EXISTS superadmin_codigos (
  id           BIGSERIAL PRIMARY KEY,
  pedido_por   BIGINT NOT NULL,
  accion       TEXT NOT NULL CHECK (accion IN ('dar', 'quitar')),
  objetivo     TEXT NOT NULL,            -- email de la cuenta
  codigo_hash  TEXT NOT NULL,
  intentos     INT NOT NULL DEFAULT 0,
  expira_at    TIMESTAMPTZ NOT NULL,
  usado_at     TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS superadmin_codigos_pedido_idx ON superadmin_codigos (pedido_por, created_at DESC);
