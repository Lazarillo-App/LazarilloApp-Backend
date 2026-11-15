-- 136: más de una cuenta de Mercado Pago por sucursal (Diego 15/11/2026: «una sucursal puede tener más de
-- una cuenta de Mercado Pago… San Justo tiene 2»). La cuenta (mp_user_id) pasa a ser parte de la clave de
-- la conexión, y cada pago guardado recuerda de qué cuenta vino. Idempotente: corre en cada arranque.
ALTER TABLE mp_pagos ADD COLUMN IF NOT EXISTS cuenta bigint;
-- Lo guardado antes: cuando la sucursal tenía una sola cuenta, es de esa.
UPDATE mp_pagos m SET cuenta = i.mp_user_id
  FROM integraciones_mercadopago i
 WHERE m.cuenta IS NULL AND i.business_id = m.business_id AND i.sucursal = m.sucursal
   AND (SELECT count(*) FROM integraciones_mercadopago j WHERE j.business_id = m.business_id AND j.sucursal = m.sucursal) = 1;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'integraciones_mercadopago_pkey'
                AND pg_get_constraintdef(oid) = 'PRIMARY KEY (business_id, sucursal)') THEN
    ALTER TABLE integraciones_mercadopago DROP CONSTRAINT integraciones_mercadopago_pkey;
    ALTER TABLE integraciones_mercadopago ALTER COLUMN mp_user_id SET NOT NULL;
    ALTER TABLE integraciones_mercadopago ADD CONSTRAINT integraciones_mercadopago_pkey PRIMARY KEY (business_id, sucursal, mp_user_id);
  END IF;
END $$;
