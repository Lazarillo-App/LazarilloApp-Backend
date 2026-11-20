-- 155 · Rubros enteros en una plaza (Diego 20/11/2026: «si coloco un rubro entero a una plaza, por ejemplo
-- Ensaladas, cuando se agregue un producto a ese rubro lo muestra solo sin que lo tenga que seleccionar»).
--   tipo: 'rubro' | 'subrubro' (los mismos grupos del editor de la plaza).
--   conocidos: los productos de ese grupo que la plaza ya vio. Solo se suman solos los que NO están acá, así
--   un producto que se sacó a mano de la plaza no vuelve a aparecer.
CREATE TABLE IF NOT EXISTS plaza_grupos (
  plaza_id   INT NOT NULL,
  tipo       TEXT NOT NULL,
  nombre     TEXT NOT NULL,
  conocidos  INT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plaza_id, tipo, nombre)
);
