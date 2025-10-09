require('dotenv').config();
const pool = require('../config/db');

const sql = `
CREATE TABLE IF NOT EXISTS insumos (
  id                SERIAL PRIMARY KEY,
  codigo_maxi       VARCHAR(255) UNIQUE,
  nombre            VARCHAR(255) NOT NULL DEFAULT '',
  unidad_med        VARCHAR(5),
  precio_ref        NUMERIC(12,2),
  rubro             VARCHAR(255),

  envase            BOOLEAN,
  vencimiento       BOOLEAN,
  resumen           BOOLEAN,
  cant_ingredientes INTEGER,

  agrupacion_base   VARCHAR(255),
  costo_ref         NUMERIC(12,2),
  nota              TEXT,

  origen            VARCHAR(20) NOT NULL DEFAULT 'maxi',
  activo            BOOLEAN NOT NULL DEFAULT TRUE,

  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

-- trigger para updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $f$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END; $f$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'insumos_set_updated_at'
  ) THEN
    CREATE TRIGGER insumos_set_updated_at
    BEFORE UPDATE ON insumos
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
`;

(async () => {
  try {
    await pool.query(sql);
    console.log('✅ Tabla "insumos" creada/actualizada');
    process.exit(0);
  } catch (e) {
    console.error('❌ Error creando tabla insumos:', e.message);
    process.exit(1);
  }
})();
