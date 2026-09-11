// db/scripts/add-receta-preparacion.js
//
// Agrega las columnas/tablas nuevas para el rediseño de "Notas e imagen de la
// receta": método de cocción + temperatura + tiempo, pasos reordenables, y
// observaciones como hilo de comentarios (con autor y notificación a
// owner/admin). Solo aplica a recetas de PRODUCTO y ELABORADO — las notas
// de insumo (NotasItemModal) no se tocan.
//
// Uso: node db/scripts/add-receta-preparacion.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  await pool.query(`
    ALTER TABLE recetas ADD COLUMN IF NOT EXISTS metodo_coccion TEXT;
    ALTER TABLE recetas ADD COLUMN IF NOT EXISTS temperatura NUMERIC;
    ALTER TABLE recetas ADD COLUMN IF NOT EXISTS tiempo_min NUMERIC;
    ALTER TABLE recetas ADD COLUMN IF NOT EXISTS pasos JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);
  console.log('✅ Columnas de método/pasos agregadas a recetas');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS receta_observaciones (
      id                    SERIAL PRIMARY KEY,
      receta_id             INT NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
      business_id           INT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
      user_id               INT REFERENCES app_users(id),
      autor_alias_snapshot  TEXT,
      texto                 TEXT NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_receta_observaciones_receta ON receta_observaciones(receta_id);
    CREATE INDEX IF NOT EXISTS ix_receta_observaciones_biz ON receta_observaciones(business_id);
  `);
  console.log('✅ Tabla receta_observaciones creada');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS metodos_coccion (
      id           SERIAL PRIMARY KEY,
      business_id  INT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
      nombre       TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (business_id, nombre)
    );
  `);
  console.log('✅ Tabla metodos_coccion creada');

  await pool.end();
  console.log('Listo.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
