// db/scripts/add-insumo-group-rules-constraint.js
//
// insumo_group_rules ya existe en producción (confirmado con
// check-insumo-group-rules.js) pero sin ninguna fila ni constraint de
// unicidad. El nuevo endpoint de guardar regla (POST /insumos/group-rules)
// hace un INSERT ... ON CONFLICT (business_id, rubro_codigo, es_elaborador)
// DO UPDATE, que necesita esa constraint para funcionar. Como la tabla está
// vacía, agregarla es seguro (no puede haber filas duplicadas que choquen).
//
// Uso: node db/scripts/add-insumo-group-rules-constraint.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE insumo_group_rules
        ADD CONSTRAINT insumo_group_rules_biz_rubro_elab_uniq
        UNIQUE (business_id, rubro_codigo, es_elaborador);
      RAISE NOTICE 'Constraint agregada.';
    EXCEPTION WHEN duplicate_object THEN
      RAISE NOTICE 'La constraint ya existía — nada que hacer.';
    END $$;
  `);
  console.log('Listo.');
  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
