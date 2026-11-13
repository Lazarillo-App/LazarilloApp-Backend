-- 123_conciliacion_por_sucursal.sql — La conciliación y Mercado Pago van por SUCURSAL (14/11/2026,
-- pedido de la usuaria): cada sucursal cobra en su propia cuenta de Mercado Pago.
-- sucursal = 0 → la principal (los datos sin branch_id, como en el resto de la app);
-- sucursal > 0 → app_branches.id.
-- Las migraciones corren en cada arranque: solo se toca cada tabla si todavía no tiene la columna.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'conciliacion_fuentes' AND column_name = 'sucursal') THEN
    ALTER TABLE conciliacion_fuentes ADD COLUMN sucursal integer NOT NULL DEFAULT 0;
    ALTER TABLE conciliacion_fuentes DROP CONSTRAINT IF EXISTS conciliacion_fuentes_pkey;
    ALTER TABLE conciliacion_fuentes ADD PRIMARY KEY (business_id, sucursal, tipo);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'conciliacion_estado' AND column_name = 'sucursal') THEN
    ALTER TABLE conciliacion_estado ADD COLUMN sucursal integer NOT NULL DEFAULT 0;
    ALTER TABLE conciliacion_estado DROP CONSTRAINT IF EXISTS conciliacion_estado_pkey;
    ALTER TABLE conciliacion_estado ADD PRIMARY KEY (business_id, sucursal, periodo);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'conciliacion_pagadores' AND column_name = 'sucursal') THEN
    ALTER TABLE conciliacion_pagadores ADD COLUMN sucursal integer NOT NULL DEFAULT 0;
    ALTER TABLE conciliacion_pagadores DROP CONSTRAINT IF EXISTS conciliacion_pagadores_pkey;
    ALTER TABLE conciliacion_pagadores ADD PRIMARY KEY (business_id, sucursal);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'integraciones_mercadopago' AND column_name = 'sucursal') THEN
    ALTER TABLE integraciones_mercadopago ADD COLUMN sucursal integer NOT NULL DEFAULT 0;
    ALTER TABLE integraciones_mercadopago DROP CONSTRAINT IF EXISTS integraciones_mercadopago_pkey;
    ALTER TABLE integraciones_mercadopago ADD PRIMARY KEY (business_id, sucursal);
  END IF;
END $$;
