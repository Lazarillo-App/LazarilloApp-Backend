// db/scripts/create-maxi-purchases-staging.js
//
// Fase 1 de la ingesta automática de MaxiRest (ver plan): crea la tabla de
// staging donde el agente Python del colega (conectado directo a Postgres,
// igual que hoy hace con el espejo crudo `maxirest_14536_ramos`) va a
// escribir las líneas de compra ya traducidas desde `mxitc`, ANTES de que
// un paso de normalización en Node las agrupe en facturas y llame a
// `purchasesStore.upsertPurchasesBatch` (sin tocar esa función).
//
// Esta tabla vive en el schema `public` de Lazarillo, no en el espejo
// crudo — es intencional: separa "lo que el agente dejó" de "lo que ya se
// transformó".
//
// Cero impacto: crear esta tabla no activa nada (nadie escribe en ella
// todavía, no hay cron corriendo sobre ella).
//
// Uso: node db/scripts/create-maxi-purchases-staging.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maxi_purchases_staging (
      id              BIGSERIAL PRIMARY KEY,
      business_id     INTEGER NOT NULL REFERENCES app_businesses(id),
      cod_pro         INTEGER,
      cod_suc         INTEGER,
      cod_cpb         TEXT,
      numero1         INTEGER,
      fecha           DATE,
      cantidad        NUMERIC(14,3),
      neto            NUMERIC(14,3),
      cod_ins         INTEGER,
      precio          NUMERIC(14,4),
      preciotot       NUMERIC(14,4),
      tasa            NUMERIC(6,2),
      iva             NUMERIC(14,2),
      ivatot          NUMERIC(14,2),
      imp_int         NUMERIC(14,2),
      imp_inttot      NUMERIC(14,2),
      cod_cga         INTEGER,
      referencia      TEXT,
      envio           INTEGER,
      orden           NUMERIC(14,2),
      synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      procesado       BOOLEAN NOT NULL DEFAULT FALSE,
      processed_at    TIMESTAMPTZ
    );
  `);

  // Clave natural de una línea de mxitc: identifica el comprobante
  // (cod_pro + cod_cpb + numero1 + cod_suc) y el insumo dentro de él
  // (cod_ins + orden, por si el mismo insumo aparece más de una vez en el
  // mismo comprobante). El agente hace upsert sobre esta clave.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS maxi_purchases_staging_uq
      ON maxi_purchases_staging (business_id, cod_pro, cod_cpb, numero1, cod_suc, cod_ins, orden);
  `);

  // El paso de normalización busca "procesado = false" por negocio.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS maxi_purchases_staging_pendientes_idx
      ON maxi_purchases_staging (business_id)
      WHERE procesado = FALSE;
  `);

  console.log('✅ Tabla maxi_purchases_staging creada (o ya existía).');
  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
