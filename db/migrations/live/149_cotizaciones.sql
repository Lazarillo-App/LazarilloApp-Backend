-- 149: cotizaciones del dólar por día (Diego 19/11/2026: el alquiler se pacta en dólares billete y se
-- debita en pesos; lo compra al blue). Se llenan solas desde fuentes públicas (DolarApi para el día,
-- ArgentinaDatos para la historia) la primera vez que se piden; sirven para sugerir el dólar de
-- referencia al cargar un gasto en US$. Son las mismas para todos los negocios.
-- Idempotente: corre en cada arranque.
CREATE TABLE IF NOT EXISTS gestion_cotizaciones (
  tipo        TEXT        NOT NULL,   -- blue | oficial | mep
  fecha       DATE        NOT NULL,
  compra      NUMERIC,
  venta       NUMERIC     NOT NULL,
  fuente      TEXT,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tipo, fecha)
);
