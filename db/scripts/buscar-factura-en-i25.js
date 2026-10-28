// db/scripts/buscar-factura-en-i25.js
//
// Diagnóstico de SOLO LECTURA. Busca un número de comprobante puntual en
// TODAS las tablas i25 (ambos años) de un schema, para confirmar si una
// factura que está guardada en purchase_items todavía existe en el i25
// actual o es un residuo de una sincronización vieja.
//
// Uso: node db/scripts/buscar-factura-en-i25.js <schema> <pdv> <fragmento_numero>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const schema = process.argv[2];
  const pdv = process.argv[3];
  const fragmento = process.argv[4];
  if (!schema || !pdv || !fragmento) {
    console.log('Uso: node db/scripts/buscar-factura-en-i25.js <schema> <pdv> <fragmento_numero>');
    process.exit(1);
  }

  const { rows: tablas } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name LIKE 'i25_compras_detalle_de_compras_%'
      ORDER BY table_name DESC`,
    [schema]
  );

  for (const t of tablas) {
    const { rows } = await pool.query(
      `SELECT * FROM "${schema}"."${t.table_name}"
        WHERE pdv = $1 AND (numero1::text LIKE $2 OR numero2::text LIKE $2)`,
      [pdv, `%${fragmento}%`]
    );
    console.log(`\n=== ${t.table_name} — ${rows.length} fila(s) ===`);
    if (rows.length) console.table(rows);
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
