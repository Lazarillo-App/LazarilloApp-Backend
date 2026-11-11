-- Tipo de descuento de cada venta (Diego 10/11/2026): el kit suma al 22 que sube a Render el código
-- del descuento de MaxiRest (mxfac.cod_dto) y su nombre (mxdto). Solo para Render; el Excel no cambia.
ALTER TABLE gestion_ventas ADD COLUMN IF NOT EXISTS "codDto" text;
ALTER TABLE gestion_ventas ADD COLUMN IF NOT EXISTS "nomDto" text;
