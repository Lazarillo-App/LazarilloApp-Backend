-- 064_compras_concepto_sin_insumo.sql
-- Líneas del 25 cargadas POR CONCEPTO (código de la línea = concepto de caja,
-- ej. "Contribuciones SS" con código 771) quedaron pegadas al insumo que tiene
-- ese mismo código (771 = FOLIOS OFICIO). El fix del sync (PR #1) evita que
-- vuelva a pasar, pero las líneas ya guardadas seguían con el insumo:
-- Bar 391 líneas ($104,6 M), FC 200 ($27,3 M), Comercio 532 ($92,1 M).
-- Se guarda respaldo (id, insumo_id) antes de soltarlas. Idempotente: corre en
-- cada arranque y la segunda vez no encuentra nada.
-- Para volver atrás:
--   UPDATE purchase_items pi SET insumo_id = r.insumo_id
--     FROM _respaldo_compras_concepto_20261102 r WHERE r.id = pi.id;

CREATE TABLE IF NOT EXISTS _respaldo_compras_concepto_20261102 AS
SELECT pi.id, pi.insumo_id
  FROM purchase_items pi
  JOIN insumos i ON i.id = pi.insumo_id
 WHERE pi.cpto_caja IS NOT NULL
   AND pi.cpto_caja::text = i.codigo_maxi;

UPDATE purchase_items pi
   SET insumo_id = NULL
  FROM insumos i
 WHERE i.id = pi.insumo_id
   AND pi.cpto_caja IS NOT NULL
   AND pi.cpto_caja::text = i.codigo_maxi;
