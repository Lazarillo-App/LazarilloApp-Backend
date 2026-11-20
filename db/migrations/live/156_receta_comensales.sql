-- 20/11/2026 — Para cuántos comensales es el plato (Diego): 1 a 10, por defecto 1. La ganancia
-- («te queda») se mide por comensal, no por plato.
ALTER TABLE recetas ADD COLUMN IF NOT EXISTS comensales SMALLINT NOT NULL DEFAULT 1;
