// db/scripts/create-receta-proposals.js
//
// Vista Operación — Fase 3: circuito de propuesta y aprobación de recetas.
// Cuando quien guarda una receta tiene rol Staff, el guardado NO escribe
// directo en `recetas`/`receta_items` — crea/actualiza una fila acá con el
// snapshot de antes y lo que propone, y la receta real solo cambia cuando un
// admin/owner aprueba (ver recetaProposalsController.js).
//
// `receta_id` es nullable: cubre tanto "ya existe una receta y la estoy
// editando" (receta_id presente) como "todavía no existe" (ej. Staff carga
// una receta nueva para un artículo que no tenía, o un elaborado nuevo).
// `article_id`/`insumo_id` quedan igual que en `recetas` (uno de los dos, el
// otro null) para poder resolver el destino aunque receta_id sea null.
//
// Uso: node db/scripts/create-receta-proposals.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS receta_proposals (
      id                 SERIAL PRIMARY KEY,
      business_id        BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
      receta_id          INT REFERENCES recetas(id) ON DELETE SET NULL,
      article_id         INT,
      insumo_id          INT,
      sector_id          INT REFERENCES sectores(id) ON DELETE SET NULL,
      created_by_user_id INT NOT NULL REFERENCES app_users(id),
      status             TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','in_revision','approved','rejected')),
      payload_before     JSONB,
      payload_after      JSONB NOT NULL,
      admin_comment      TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at         TIMESTAMPTZ,
      decided_by         INT REFERENCES app_users(id)
    );
    CREATE INDEX IF NOT EXISTS ix_receta_proposals_business ON receta_proposals(business_id);
    CREATE INDEX IF NOT EXISTS ix_receta_proposals_status   ON receta_proposals(business_id, status);
    CREATE INDEX IF NOT EXISTS ix_receta_proposals_receta   ON receta_proposals(receta_id);
  `);
  console.log('✅ Tabla receta_proposals creada');

  await pool.query(`
    ALTER TABLE recetas ADD COLUMN IF NOT EXISTS has_pending_proposal BOOLEAN NOT NULL DEFAULT FALSE;
  `);
  console.log('✅ Columna has_pending_proposal agregada a recetas');

  await pool.end();
  console.log('Listo.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
