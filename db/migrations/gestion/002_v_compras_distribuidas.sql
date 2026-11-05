-- db/migrations/gestion/002_v_compras_distribuidas.sql
--
-- Vista de lazarillo_gestion `v_compras_distribuidas` (misma lógica, multi-negocio).
-- Cada compra aparece una vez en el negocio/sucursal donde se cargó, salvo las
-- distribuidas por una regla de apertura: esas aparecen una vez por destino, con el
-- importe calculado, en el negocio/sucursal DESTINO (que puede ser otro negocio de
-- la misma organización). business_id_origen / branch_id_origen = donde se cargó.
--
-- En gestion: localId/puntoDeVentaId = destino, localIdOrigen/puntoDeVentaIdOrigen = origen.
-- Se aplica con: node db/scripts/aplicar-sql-gestion.js 002_v_compras_distribuidas.sql [--aplicar]
-- fechaPago: la corregida a mano ("fechaPagoManual", Diego 05/11/2026) manda sobre la del informe.
-- La columna la agrega db/migrations/live/067_gestion_fecha_pago_manual.sql (que también reaplica esta vista).

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
