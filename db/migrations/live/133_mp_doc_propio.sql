-- 133: CUIT/DNI de la cuenta de Mercado Pago conectada (Diego 14/11/2026: en Clientes aparecía como
-- cliente un pagador con el mismo CUIT del negocio). Se completa solo (GET /users/me) la primera
-- vez que se abre Clientes; los pagos de esas cuentas propias no cuentan como clientes.
ALTER TABLE integraciones_mercadopago ADD COLUMN IF NOT EXISTS mp_doc text;
