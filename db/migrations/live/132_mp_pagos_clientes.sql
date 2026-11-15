-- 132: Clientes (Diego 14/11/2026: base de clientes con lo que trae Mercado Pago, lista para
-- exportar, orientada a marketing). Datos del pagador sacados del pago guardado entero, como
-- columnas calculadas al grabar: la pantalla de Clientes suma sin abrir cada JSON (1,1 s → ms).
ALTER TABLE mp_pagos ADD COLUMN IF NOT EXISTS payer_id text
  GENERATED ALWAYS AS (raw->'payer'->>'id') STORED;
ALTER TABLE mp_pagos ADD COLUMN IF NOT EXISTS payer_email text
  GENERATED ALWAYS AS (NULLIF(raw->'payer'->>'email', '')) STORED;
ALTER TABLE mp_pagos ADD COLUMN IF NOT EXISTS payer_doc text
  GENERATED ALWAYS AS (NULLIF(raw->'payer'->'identification'->>'number', '')) STORED;
ALTER TABLE mp_pagos ADD COLUMN IF NOT EXISTS payer_doc_tipo text
  GENERATED ALWAYS AS (NULLIF(raw->'payer'->'identification'->>'type', '')) STORED;
ALTER TABLE mp_pagos ADD COLUMN IF NOT EXISTS payer_nombre text
  GENERATED ALWAYS AS (COALESCE(
    NULLIF(extra->>'nombre', ''),
    NULLIF(raw->'point_of_interaction'->'transaction_data'->'bank_info'->'payer'->>'long_name', ''),
    NULLIF(btrim(COALESCE(raw->'payer'->>'first_name', '') || ' ' || COALESCE(raw->'payer'->>'last_name', '')), ''),
    NULLIF(raw->'card'->'cardholder'->>'name', ''))) STORED;
ALTER TABLE mp_pagos ADD COLUMN IF NOT EXISTS importe numeric
  GENERATED ALWAYS AS ((raw->>'transaction_amount')::numeric) STORED;
ALTER TABLE mp_pagos ADD COLUMN IF NOT EXISTS medio text
  GENERATED ALWAYS AS (raw->>'payment_type_id') STORED;
CREATE INDEX IF NOT EXISTS mp_pagos_payer_idx ON mp_pagos (business_id, rol, payer_id);
