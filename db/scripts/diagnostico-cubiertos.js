// db/scripts/diagnostico-cubiertos.js — SOLO LECTURA (usuaria 25/11/2026).
// ¿Cómo guarda el POS los cubiertos (gestion_ventas.cub) cuando una mesa paga con varios medios
// (varias filas con el mismo comprobante)? De esto depende cómo se cuentan los cubiertos en el detalle
// de ventas: sumar las filas puede duplicar.
//
// Uso (Render Shell):  node db/scripts/diagnostico-cubiertos.js [texto del nombre del negocio] [días]
//   ej.: node db/scripts/diagnostico-cubiertos.js comercio 60
// No escribe nada: la transacción es READ ONLY y termina en ROLLBACK.
'use strict';
const pool = require('../../config/db');

const nombre = process.argv[2] || 'comercio';
const dias = Number(process.argv[3]) || 60;

(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const { rows: negs } = await c.query('SELECT id, name FROM app_businesses WHERE name ILIKE $1 ORDER BY id', [`%${nombre}%`]);
    if (!negs.length) console.log(`No hay negocios con «${nombre}» en el nombre.`);
    for (const n of negs) {
      const { rows } = await c.query(`
        WITH v AS (
          SELECT fecha::date AS dia, comprobant, cobro,
                 COALESCE(NULLIF(regexp_replace(COALESCE(cub::text, ''), '[^0-9]', '', 'g'), '')::int, 0) AS cub
            FROM gestion_ventas WHERE business_id = $1 AND fecha >= now() - ($2::int * interval '1 day') AND comprobant IS NOT NULL
        ), t AS (
          SELECT dia, comprobant, COUNT(*) AS filas, MIN(cub) AS mn, MAX(cub) AS mx, SUM(cub) AS suma,
                 COUNT(*) FILTER (WHERE cub > 0) AS filas_con_cub
            FROM v GROUP BY 1, 2
        )
        SELECT COUNT(*)::int AS comprobantes,
               COUNT(*) FILTER (WHERE filas > 1)::int AS pagados_con_varias_filas,
               COUNT(*) FILTER (WHERE filas > 1 AND mn = mx AND mx > 0)::int AS repite_cub_en_cada_fila,
               COUNT(*) FILTER (WHERE filas > 1 AND filas_con_cub = 1)::int AS cub_solo_en_una_fila,
               COUNT(*) FILTER (WHERE filas > 1 AND filas_con_cub > 1 AND mn <> mx)::int AS cub_distinto_por_fila,
               COUNT(*) FILTER (WHERE filas > 1 AND mx = 0)::int AS sin_cub,
               COALESCE(SUM(suma), 0)::int AS cub_sumando_filas,
               COALESCE(SUM(mx), 0)::int AS cub_una_vez_por_comprobante
          FROM t`, [n.id, dias]);
      console.log(`\n${n.id} · ${n.name} · últimos ${dias} días`);
      console.table(rows[0]);
    }
    await c.query('ROLLBACK');
  } finally {
    c.release();
    await pool.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
