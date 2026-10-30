// db/scripts/verificar-codigo-en-m0.js
//
// Diagnóstico de SOLO LECTURA. Busca un código de insumo en el maestro
// m0_listado_de_insumos_con_discontinuados (la fuente real de MaxiRest)
// para ver qué nombre/rubro le da MaxiRest — por si el codigo_maxi
// guardado en Lazarillo quedó mal asignado (ej. apunta a un código que en
// MaxiRest es otra cosa, no el insumo que creemos).
//
// Uso: node db/scripts/verificar-codigo-en-m0.js <schema> <codigo>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const schema = process.argv[2];
  const codigo = process.argv[3];
  if (!schema || !codigo) {
    console.log('Uso: node db/scripts/verificar-codigo-en-m0.js <schema> <codigo>');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT * FROM "${schema}".m0_listado_de_insumos_con_discontinuados WHERE codigo = $1`,
    [codigo]
  );
  console.log(`=== m0 en ${schema}, codigo=${codigo} (${rows.length} fila(s)) ===`);
  console.table(rows);

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
