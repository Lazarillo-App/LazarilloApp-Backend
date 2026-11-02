-- 065_compras_csv_duplicadas.sql
-- Compras cargadas dos veces: un CSV importado a mano (source = 'csv') repetía
-- facturas que ya habían llegado de MaxiRest. Comercio (210), import del
-- 31/10/2026: 1.316 de 1.338 facturas CSV tienen par en MaxiRest (mismo
-- proveedor y fecha; el CSV trae el importe CON IVA). Duplicaba el food cost
-- (64% en vez de ~32%). Regla: MaxiRest manda — se quitan las CSV que tienen
-- par; las CSV sin par (22 en Comercio) se quedan.
-- Desde este cambio el import CSV ya no carga facturas que MaxiRest trajo, y
-- el sync de MaxiRest reemplaza a la CSV del mismo proveedor y fecha.
--
-- Respaldo antes de borrar. Idempotente: corre en cada arranque y la segunda
-- vez no encuentra nada (y no pisa el respaldo).
-- Para volver atrás:
--   INSERT INTO purchases SELECT * FROM _respaldo_compras_csv_dup_20261102;
--   INSERT INTO purchase_items SELECT * FROM _respaldo_items_csv_dup_20261102;

CREATE TABLE IF NOT EXISTS _respaldo_compras_csv_dup_20261102 AS
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

CREATE TABLE IF NOT EXISTS _respaldo_items_csv_dup_20261102 AS
SELECT pi.*
  FROM purchase_items pi
 WHERE pi.purchase_id IN (SELECT id FROM _respaldo_compras_csv_dup_20261102);

DELETE FROM purchase_items
 WHERE purchase_id IN (SELECT id FROM _respaldo_compras_csv_dup_20261102);

DELETE FROM purchases
 WHERE id IN (SELECT id FROM _respaldo_compras_csv_dup_20261102);
