-- El tablero de gastos quedaba cargando (statement timeout, 06/11/2026): la vista
-- gestion_v_compras_distribuidas filtra por COALESCE("fechaManual", COALESCE(periodo, fecha)) desde
-- live/067 y Postgres no tenía estadísticas de esa expresión → estimaba 1 fila (eran 6.000) y elegía
-- un nested loop de 41 M de comparaciones (37 s). El índice por la expresión le da las estadísticas.
-- Solo agrega un índice; no toca datos.
CREATE INDEX IF NOT EXISTS gestion_compras_biz_branch_fecha_economica_idx
  ON gestion_compras (business_id, branch_id, (COALESCE("fechaManual", COALESCE(periodo, fecha))));
ANALYZE gestion_compras;
