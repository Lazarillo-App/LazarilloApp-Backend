-- 066_compras_csv_duplicadas_bis.sql
-- Misma limpieza que 065, para lo que se volvió a duplicar el 02/11/2026:
-- producción (main) todavía no tiene el freno del import CSV (está en
-- testing), y ese día se volvió a subir el CSV de compras en Comercio (210,
-- lote 20261102-190007: 1.316 facturas con par en MaxiRest) y en Bar (147,
-- lote 20261102-193642: 138 con par — ej. A 0008-00059565 de Nesquik). El food
-- cost de Bar pasó de ~28% a ~51% en ese momento.
-- Regla: MaxiRest manda — se quitan las CSV que tienen par (mismo negocio,
-- proveedor, fecha y sucursal); las CSV sin par se quedan.
--
-- Respaldo antes de borrar. Idempotente: la segunda vez el respaldo ya existe
-- y el DELETE no encuentra nada.
-- Para volver atrás:
--   INSERT INTO purchases SELECT * FROM _respaldo_compras_csv_dup_20261102b;
--   INSERT INTO purchase_items SELECT * FROM _respaldo_items_csv_dup_20261102b;

CREATE TABLE IF NOT EXISTS _respaldo_compras_csv_dup_20261102b AS
SELECT p.*
  FROM purchases p
 WHERE p.source = 'csv'
   AND EXISTS (
     SELECT 1 FROM purchases m
      WHERE m.business_id = p.business_id
        AND m.source IS DISTINCT FROM 'csv'
        AND m.proveedor_id IS NOT DISTINCT FROM p.proveedor_id
        AND m.fecha::date = p.fecha::date
        AND COALESCE(m.branch_id, -1) = COALESCE(p.branch_id, -1)
   );

CREATE TABLE IF NOT EXISTS _respaldo_items_csv_dup_20261102b AS
SELECT pi.*
  FROM purchase_items pi
 WHERE pi.purchase_id IN (SELECT id FROM _respaldo_compras_csv_dup_20261102b);

DELETE FROM purchase_items
 WHERE purchase_id IN (SELECT id FROM _respaldo_compras_csv_dup_20261102b);

DELETE FROM purchases
 WHERE id IN (SELECT id FROM _respaldo_compras_csv_dup_20261102b);
