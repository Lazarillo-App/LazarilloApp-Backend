-- 137: cada cuenta de Mercado Pago (o banco) va vinculada a un proveedor (Diego 15/11/2026: «al asociar un
-- banco lo tenemos que vincular con un proveedor»). A ese proveedor van sus comisiones (como pagos de su
-- cuenta corriente) y sus impuestos (débitos y créditos, retenciones de IIBB). codPro de gestion_proveedores.
ALTER TABLE integraciones_mercadopago ADD COLUMN IF NOT EXISTS proveedor_cod text;
