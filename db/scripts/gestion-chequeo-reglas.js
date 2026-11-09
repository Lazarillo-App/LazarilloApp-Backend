// db/scripts/gestion-chequeo-reglas.js
// Chequeo de SOLO LECTURA de las reglas de apertura (reparto de gastos entre negocios/sucursales):
// reglas sin destinos, destinos que no suman 100%, y compras marcadas como repartidas sin reparto.
//   node db/scripts/gestion-chequeo-reglas.js
'use strict';

require('dotenv').config({ quiet: true });
const pool = require('../../config/db');

(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const { rows } = await c.query(`
      WITH r AS (
        SELECT r.organization_id, r.id, r.estado,
               (SELECT COUNT(*) FROM gestion_destinos_regla d WHERE d."reglaId" = r.id) AS destinos,
               (SELECT COALESCE(SUM(porcentaje), 0) FROM gestion_destinos_regla d WHERE d."reglaId" = r.id) AS suma,
               (SELECT COUNT(*) FROM gestion_distribuciones_apertura x WHERE x."reglaId" = r.id) AS repartos
          FROM gestion_reglas_apertura r)
      SELECT organization_id AS org,
             COUNT(*)::int AS reglas,
             COUNT(*) FILTER (WHERE estado = 'activa')::int AS activas,
             COUNT(*) FILTER (WHERE destinos = 0)::int AS sin_destinos,
             COUNT(*) FILTER (WHERE destinos > 0 AND ABS(suma - 100) > 0.01)::int AS no_suman_100,
             SUM(repartos)::int AS repartos
        FROM r GROUP BY 1 ORDER BY 1`);
    console.table(rows);
    const { rows: sinReparto } = await c.query(`
      SELECT business_id, COUNT(*)::int AS n FROM gestion_compras cp
       WHERE "esDistribuido" AND NOT EXISTS (SELECT 1 FROM gestion_distribuciones_apertura x
                                              WHERE x.compra_business_id = cp.business_id AND x."compraRowId" = cp."rowId")
       GROUP BY 1 ORDER BY 1`);
    console.log('Compras marcadas como repartidas pero sin reparto:', sinReparto.length ? JSON.stringify(sinReparto) : 'ninguna');
    const ok = rows.every((x) => x.sin_destinos === 0 && x.no_suman_100 === 0) && !sinReparto.length;
    console.log(ok ? '\nOK: todas las reglas tienen destinos y todo lo repartido tiene su reparto.' : '\nREVISAR: mandale esta salida a Claude.');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
    await pool.end();
  }
})().catch((e) => { console.error('FALLA:', e.message); process.exit(1); });
