// db/scripts/create-purchase-payments.js
//
// Pipeline completo de MaxiRest — parte de Compras, detalle de PAGO
// (i80_compras_detalle_de_pagos del colega). Hasta ahora no existía nada en
// Lazarillo que guardara CÓMO/CUÁNDO se pagó una factura de compra (solo el
// total de la factura en `purchases`). Una factura puede tener varios pagos
// (cuotas, distintos métodos) — por eso es una tabla aparte, no columnas en
// `purchases`.
//
// `purchase_id` es nullable a propósito: el pago puede sincronizarse antes,
// después o sin que nunca aparezca la factura correspondiente en i25 (ej. si
// es de un año que todavía no se sincronizó) — se guarda igual, con
// `factura_key` para poder re-vincular después.
//
// Por ahora es solo almacenamiento — no hay pantalla que lo muestre todavía
// (decisión explícita: primero el dato confiable en base, la UI después).
//
// Uso: node db/scripts/create-purchase-payments.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchase_payments (
      id              BIGSERIAL PRIMARY KEY,
      business_id     BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
      purchase_id     INT REFERENCES purchases(id) ON DELETE SET NULL,
      factura_key     TEXT NOT NULL,
      pdv             TEXT,
      orden_maxi      BIGINT,
      forma_pago      TEXT,
      importe         NUMERIC,
      fecha_pago      DATE,
      cheque_numero   BIGINT,
      cheque_fecha_vto TEXT,
      cheque_importe  NUMERIC,
      banco_codigo    BIGINT,
      banco_nombre    TEXT,
      cod_cga         BIGINT,
      nom_cga         TEXT,
      cod_rga         BIGINT,
      nom_rga         TEXT,
      cod_ctg         BIGINT,
      nom_ctg         TEXT,
      synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (business_id, orden_maxi)
    );
    CREATE INDEX IF NOT EXISTS ix_purchase_payments_business ON purchase_payments(business_id);
    CREATE INDEX IF NOT EXISTS ix_purchase_payments_purchase ON purchase_payments(purchase_id);
    CREATE INDEX IF NOT EXISTS ix_purchase_payments_factura_key ON purchase_payments(business_id, factura_key);
  `);
  console.log('✅ Tabla purchase_payments creada');

  await pool.end();
  console.log('Listo.');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
