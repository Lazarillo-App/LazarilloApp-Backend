-- 003: ámbito de las proyecciones de ingresos guardadas.
-- En gestion el ámbito era "<local>/<pdv>" (con * = todos). En Lazarillo es la sucursal del
-- filtro: '*' = todas, 'principal' = la principal (branch_id NULL), '<id>' = esa sucursal.
-- Hace falta porque "todas" y "la principal" tienen las dos branch_id NULL y no se deben mezclar
-- (cada método se evalúa contra lo que proyectó para ese mismo ámbito).
ALTER TABLE gestion_proyecciones_ingresos ADD COLUMN IF NOT EXISTS ambito TEXT NOT NULL DEFAULT '*';
DROP INDEX IF EXISTS gestion_proyecciones_ingresos_key;
CREATE UNIQUE INDEX IF NOT EXISTS gestion_proyecciones_ingresos_ambito_key
  ON gestion_proyecciones_ingresos (business_id, ambito, anio, mes, corte, metodo);
