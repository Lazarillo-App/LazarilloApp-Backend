-- 156 · Feriado de la Soberanía Nacional 2026: el default sembraba el viernes 20/11, pero
-- en 2026 se trasladó al lunes 23/11 (Diego 20/11/2026: en Bar quedó cargado dos veces).
-- Solo toca el feriado sembrado (compartido, tipo feriado, 20/11/2026, «Soberan…»):
--   · si el negocio ya tiene algo cargado el 23/11, se borra el del 20 (queda el del usuario);
--   · si no, se pasa al 23/11.
-- Corre en cada arranque: después de la primera vez no encuentra nada que cambiar.
DELETE FROM rrhh_fechas f
 WHERE f.fecha = DATE '2026-11-20' AND f.compartida AND f.tipo = 'feriado'
   AND f.nombre ILIKE 'Soberan%'
   AND EXISTS (SELECT 1 FROM rrhh_fechas o
                WHERE o.business_id = f.business_id AND o.compartida
                  AND COALESCE(o.branch_id, 0) = COALESCE(f.branch_id, 0)
                  AND o.fecha = DATE '2026-11-23');

UPDATE rrhh_fechas f SET fecha = DATE '2026-11-23'
 WHERE f.fecha = DATE '2026-11-20' AND f.compartida AND f.tipo = 'feriado'
   AND f.nombre ILIKE 'Soberan%';
