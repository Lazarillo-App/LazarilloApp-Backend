// db/scripts/create-sectores.js
//
// Vista Operación — Fase 1: tablas para "sector" (recorte de adentro de un
// negocio, armado tildando agrupaciones/rubros/subrubros). Un sector define
// qué recetas ve el Staff asignado a él.
//
// Rubro/subrubro no son tablas propias (son columnas de texto libre en cada
// artículo — "Rubro" en la UI = columna subrubro, "Subrubro" en la UI =
// columna categoria) y el mismo texto de rubro puede repetirse en agrupaciones
// distintas sin relación entre sí (mismo criterio ya usado en
// VistaCartaMenu.jsx para "bloques": ver `${agrupacionId}|${subrubro}`). Por
// eso un scope de tipo rubro/subrubro siempre guarda también la agrupación
// bajo la que se tildó.
//
// También suma sector_ids a user_assignments — se completa recién en la Fase 2
// (invitar con sector), pero se agrega ya para no pedir una segunda migración.
//
// Uso: node db/scripts/create-sectores.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sectores (
      id           SERIAL PRIMARY KEY,
      business_id  BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
      nombre       TEXT NOT NULL,
      color        TEXT,
      es_fijo      BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_sectores_business ON sectores(business_id);
  `);
  console.log('✅ Tabla sectores creada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sector_scope_items (
      id             SERIAL PRIMARY KEY,
      sector_id      INT NOT NULL REFERENCES sectores(id) ON DELETE CASCADE,
      tipo           TEXT NOT NULL CHECK (tipo IN ('agrupacion','rubro','subrubro')),
      agrupacion_id  INT NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
      rubro          TEXT,
      subrubro       TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_sector_scope_items_sector ON sector_scope_items(sector_id);
  `);
  console.log('✅ Tabla sector_scope_items creada');

  await pool.query(`
    ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS sector_ids INT[];
  `);
  console.log('✅ Columna sector_ids agregada a user_assignments (se completa desde la Fase 2)');

  await pool.end();
  console.log('Listo.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
