// db/scripts/create-articulo-group-rules.js
//
// Regla persistente rubro→agrupación para Artículos — equivalente de
// insumo_group_rules (que ya existe para Insumos) pero del lado de
// Artículos, donde no existía nada todavía.
//
// Artículos no tienen una tabla de rubros con código propio como los
// insumos (insumo_rubros) — "Rubro" en la UI es la columna de texto libre
// maxi_articles.subrubro (ver nota en create-sectores.js). Por eso acá se
// guarda el texto del rubro directamente, sin código ni es_elaborador
// (ese flag es específico de insumos).
//
// Uso: node db/scripts/create-articulo-group-rules.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS articulo_group_rules (
      id           SERIAL PRIMARY KEY,
      business_id  BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
      rubro        TEXT NOT NULL,
      group_id     INT NOT NULL REFERENCES agrupaciones(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (business_id, rubro)
    );
    CREATE INDEX IF NOT EXISTS ix_articulo_group_rules_business ON articulo_group_rules(business_id);
  `);
  console.log('✅ Tabla articulo_group_rules creada');

  await pool.end();
  console.log('Listo.');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
