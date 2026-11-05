-- 067_gestion_fecha_pago_manual.sql
-- Panel de Gestión: corregir a mano la FECHA DE PAGO aunque venga de MaxiRest
-- (pedido de Diego, 05/11/2026).
--  - gestion_compras."fechaPagoManual": gastos varios y sueldos (fecha de pago del 14).
--  - gestion_pagos."fechaPagoManual": cada pago de una factura (informe 80).
-- Se guarda aparte: la reimportación pisa "fechaPago" pero nunca la manual, y los
-- lectores usan COALESCE("fechaPagoManual", "fechaPago"). null = vuelve la del informe.
-- Idempotente (corre en cada arranque). Para volver atrás: poner las columnas en NULL.

ALTER TABLE gestion_compras ADD COLUMN IF NOT EXISTS "fechaPagoManual" TIMESTAMP(3);
ALTER TABLE gestion_pagos   ADD COLUMN IF NOT EXISTS "fechaPagoManual" TIMESTAMP(3);

-- Misma vista que db/migrations/gestion/002 (ya con la fecha de pago manual).
CREATE OR REPLACE VIEW gestion_v_compras_distribuidas AS
SELECT c."rowId",
       NULL::integer AS "distribucionId",
       c.business_id,
       c.branch_id,
       c.business_id AS business_id_origen,
       c.branch_id AS branch_id_origen,
       c.importe,
       c."importeManual",
       c.fecha,
       c."fechaManual",
       c."conceptoCodigo",
       c."conceptoCodigoManual",
       c.concepto,
       c.detalle,
       c.observac,
       c."observacManual",
       c.proveedor,
       c."proveedorId",
       c.codigo,
       c.periodo,
       c.comprobante,
       COALESCE(c."fechaPagoManual", c."fechaPago")::timestamp(3) AS "fechaPago"
  FROM gestion_compras c
 WHERE c."esDistribuido" = false
UNION ALL
SELECT c."rowId",
       d.id AS "distribucionId",
       dr.business_id,
       dr.branch_id,
       c.business_id AS business_id_origen,
       c.branch_id AS branch_id_origen,
       d."importeCalculado" AS importe,
       NULL::numeric AS "importeManual",
       c.fecha,
       c."fechaManual",
       c."conceptoCodigo",
       c."conceptoCodigoManual",
       c.concepto,
       c.detalle,
       c.observac,
       c."observacManual",
       c.proveedor,
       c."proveedorId",
       c.codigo,
       c.periodo,
       c.comprobante,
       COALESCE(c."fechaPagoManual", c."fechaPago")::timestamp(3) AS "fechaPago"
  FROM gestion_distribuciones_apertura d
  JOIN gestion_compras c ON c.business_id = d.compra_business_id AND c."rowId" = d."compraRowId"
  JOIN gestion_destinos_regla dr ON dr.id = d."destinoId"
 WHERE c."esDistribuido" = true;
