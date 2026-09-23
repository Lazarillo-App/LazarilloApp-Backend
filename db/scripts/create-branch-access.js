// db/scripts/create-branch-access.js
//
// Vista Operación — Fase 2: QR de acceso por sucursal + registro de
// pendientes. Una sucursal tiene un código fijo (no expira, no se regenera
// solo) que solo permite PEDIR acceso — el administrador aprueba a cada
// persona y ahí recién le asigna rol y sector.
//
// Uso: node db/scripts/create-branch-access.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS branch_access_codes (
      id           SERIAL PRIMARY KEY,
      branch_id    BIGINT NOT NULL UNIQUE,
      business_id  BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
      code         TEXT NOT NULL UNIQUE,
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_by   BIGINT REFERENCES app_users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_branch_access_codes_business ON branch_access_codes(business_id);
  `);
  console.log('✅ Tabla branch_access_codes creada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_requests (
      id                     SERIAL PRIMARY KEY,
      branch_access_code_id  INT NOT NULL REFERENCES branch_access_codes(id) ON DELETE CASCADE,
      business_id            BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
      branch_id              BIGINT,
      nombre                 TEXT NOT NULL,
      celular                TEXT,
      email                  TEXT,
      canal                  TEXT NOT NULL CHECK (canal IN ('celular','email')),
      otp_code_hash          TEXT,
      otp_expires_at         TIMESTAMPTZ,
      confirmed_at           TIMESTAMPTZ,
      status                 TEXT NOT NULL DEFAULT 'pending_otp'
                               CHECK (status IN ('pending_otp','pending_approval','approved','rejected')),
      user_id                BIGINT REFERENCES app_users(id),
      decided_at             TIMESTAMPTZ,
      decided_by             BIGINT REFERENCES app_users(id),
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_access_requests_business ON access_requests(business_id);
    CREATE INDEX IF NOT EXISTS ix_access_requests_status ON access_requests(status);
  `);
  console.log('✅ Tabla access_requests creada');

  await pool.end();
  console.log('Listo.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
