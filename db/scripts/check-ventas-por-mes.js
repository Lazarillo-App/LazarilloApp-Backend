// db/scripts/check-ventas-por-mes.js
//
// Diagnóstico de SOLO LECTURA. Ventas totales por mes para un negocio, y
// la fecha más reciente con datos — para ver si octubre (mes en curso)
// está incompleto y por eso dispara el % de food cost (que divide por
// ventas), independiente de cualquier tema de compras duplicadas.
//
// Uso: node db/scripts/check-ventas-por-mes.js <business_id>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const businessId = Number(process.argv[2]);
  if (!Number.isFinite(businessId)) {
    console.log('Uso: node db/scripts/check-ventas-por-mes.js <business_id>');
    process.exit(1);
  }

  const { rows: tablas } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name ILIKE '%sale%'
      ORDER BY table_name`
  );
  console.log('Tablas con "sale" en el nombre:', tablas.map(r => r.table_name));

  // Intento genérico: la mayoría de estas tablas tienen business_id + fecha + algún total.
  for (const t of tablas) {
    try {
      const { rows: cols } = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t.table_name]
      );
      const colNames = cols.map(c => c.column_name);
      if (!colNames.includes('business_id')) continue;
      const fechaCol = ['fecha', 'date', 'day', 'sale_date'].find(c => colNames.includes(c));
      if (!fechaCol) continue;
      const totalCol = ['total', 'amount', 'importe', 'monto', 'total_amount'].find(c => colNames.includes(c));

      const { rows } = await pool.query(
        `SELECT to_char(${fechaCol}, 'YYYY-MM') AS mes, COUNT(*)::int AS filas
               ${totalCol ? `, SUM(${totalCol})::numeric(14,2) AS total` : ''}
           FROM "${t.table_name}"
          WHERE business_id = $1
          GROUP BY 1 ORDER BY 1 DESC LIMIT 10`,
        [businessId]
      );
      console.log(`\n=== ${t.table_name} (fecha=${fechaCol}${totalCol ? `, total=${totalCol}` : ''}) ===`);
      console.table(rows);
    } catch (e) {
      console.log(`(${t.table_name}: ${e.message})`);
    }
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
