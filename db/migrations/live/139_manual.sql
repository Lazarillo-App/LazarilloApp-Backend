-- 139: Manual de Lazarillo como libro (Diego 16/11/2026: «el manual tiene que ser un libro con
-- índice, textos e imágenes; el paso a paso de Anthony es el complemento»).
-- Un capítulo por tema; las secciones van en orden dentro de un jsonb:
--   [{ id, titulo, texto, imagen, pie, tip }]  (texto: párrafos separados por línea en blanco,
--   **negrita** y renglones que empiezan con «- » como lista).
-- Lo leen todos los usuarios con sesión; lo escriben los super usuarios (Panel super).
-- Idempotente (corre en cada arranque).
CREATE TABLE IF NOT EXISTS manual_capitulos (
  id          text PRIMARY KEY,               -- slug: «corregir-un-registro»
  grupo       text NOT NULL,                  -- módulo del índice: Recetas, Resultados…
  titulo      text NOT NULL,
  resumen     text NOT NULL DEFAULT '',
  guia_id     text,                           -- guía de Anthony que lo muestra en la app (guias.js)
  orden       integer NOT NULL DEFAULT 0,
  secciones   jsonb NOT NULL DEFAULT '[]'::jsonb,
  publicado   boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint
);
