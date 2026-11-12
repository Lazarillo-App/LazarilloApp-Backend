-- 091: plazas de despacho (Diego 11/11/2026). Subsectores de Cocina/Barra (ej. Ensaladas, Freidora)
-- con sus productos. Cada producto se ve como su receta tal cual, con el orden (drag and drop),
-- los ingredientes ocultos (ojito) y renglones extra (notas, vajilla) que guarda plaza_fichas.
-- El color es por insumo (ref) y vale para todas las plazas del negocio.
CREATE TABLE IF NOT EXISTS plazas (
  id          SERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL,
  sector_id   INT NOT NULL,
  nombre      TEXT NOT NULL,
  orden       INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_plazas_business ON plazas (business_id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS plaza_productos (
  plaza_id   INT NOT NULL,
  article_id INT NOT NULL,
  orden      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (plaza_id, article_id)
);
CREATE TABLE IF NOT EXISTS plaza_fichas (
  plaza_id   INT NOT NULL,
  article_id INT NOT NULL,
  layout     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by BIGINT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plaza_id, article_id)
);
CREATE TABLE IF NOT EXISTS despacho_colores (
  business_id BIGINT NOT NULL,
  ref         TEXT NOT NULL,
  color       SMALLINT NOT NULL,
  PRIMARY KEY (business_id, ref)
);

-- Plaza de prueba pedida por Diego: «Ensaladas (prueba)» en Cocina de CONTAINER BAR (negocio 147).
INSERT INTO plazas (business_id, sector_id, nombre)
SELECT 147, 16, 'Ensaladas (prueba)'
 WHERE EXISTS (SELECT 1 FROM sectores WHERE id = 16 AND business_id = 147)
   AND NOT EXISTS (SELECT 1 FROM plazas WHERE business_id = 147 AND nombre = 'Ensaladas (prueba)');
INSERT INTO plaza_productos (plaza_id, article_id, orden)
SELECT p.id, a.article_id, a.orden
  FROM plazas p, (VALUES (64, 1), (764, 2), (66, 3), (677, 4), (311, 5), (1233, 6)) AS a(article_id, orden)
 WHERE p.business_id = 147 AND p.nombre = 'Ensaladas (prueba)' AND p.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM plaza_productos pp WHERE pp.plaza_id = p.id)
ON CONFLICT DO NOTHING;
