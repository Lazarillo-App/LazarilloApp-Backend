// db/scripts/listar-recetas-con-observaciones.js
//
// SOLO LECTURA (transacción READ ONLY): lista recetas que ya tienen observaciones, para
// revisarlas en pantalla.
//   - Por ingrediente: receta_items.notas (las trae la importación de recetas de MaxiRest,
//     columna OBSERVACIONES, o se cargan a mano en la fila del ingrediente).
//   - De la receta: el hilo de receta_observaciones (lo que escribe alguien en la receta).
//
// Uso (Render Shell):  node db/scripts/listar-recetas-con-observaciones.js [business_id] [limite]
//   sin business_id → todos los negocios; limite por defecto 15 por lista.
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

const BIZ = Number(process.argv[2]) || null;
const LIMITE = Math.min(Number(process.argv[3]) || 15, 100);

async function existe(client, tabla) {
  const { rows } = await client.query(`SELECT to_regclass($1) AS t`, [`public.${tabla}`]);
  return !!rows[0].t;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');

    if (await existe(client, 'receta_items')) {
      const conInsumo = (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='recetas' AND column_name='insumo_id'`)).rowCount > 0;
      const tipo = conInsumo ? "CASE WHEN r.insumo_id IS NOT NULL THEN 'elaborado' ELSE 'artículo' END" : "'artículo'";
      const grupoTipo = conInsumo ? ', r.insumo_id' : '';
      const { rows } = await client.query(
        `SELECT b.id AS negocio_id, b.name AS negocio,
                ${tipo} AS tipo,
                r.nombre AS receta, count(*)::int AS ingredientes_con_obs,
                left(string_agg(coalesce(ri.nombre_insumo_maxi, '?') || ': ' || trim(ri.notas), ' | ' ORDER BY ri.orden), 160) AS ejemplo
           FROM receta_items ri
           JOIN recetas r ON r.id = ri.receta_id
           JOIN app_businesses b ON b.id = r.business_id
          WHERE coalesce(trim(ri.notas), '') <> ''
            AND ($1::int IS NULL OR r.business_id = $1)
          GROUP BY b.id, b.name, r.id, r.nombre${grupoTipo}
          ORDER BY count(*) DESC, r.nombre
          LIMIT $2`,
        [BIZ, LIMITE]
      );
      console.log(`\n── Recetas con observaciones en sus ingredientes (${rows.length}) ──`);
      console.table(rows);
    } else {
      console.log('No existe la tabla receta_items en esta base.');
    }

    if (await existe(client, 'receta_observaciones')) {
      const { rows } = await client.query(
        `SELECT b.id AS negocio_id, b.name AS negocio, r.nombre AS receta,
                count(*)::int AS observaciones, max(o.created_at)::date AS ultima,
                left((array_agg(o.texto ORDER BY o.created_at DESC))[1], 120) AS ultima_obs
           FROM receta_observaciones o
           JOIN recetas r ON r.id = o.receta_id
           JOIN app_businesses b ON b.id = o.business_id
          WHERE ($1::int IS NULL OR o.business_id = $1)
          GROUP BY b.id, b.name, r.id, r.nombre
          ORDER BY max(o.created_at) DESC
          LIMIT $2`,
        [BIZ, LIMITE]
      );
      console.log(`\n── Recetas con observaciones propias (hilo de la receta) (${rows.length}) ──`);
      console.table(rows);
    } else {
      console.log('No existe la tabla receta_observaciones en esta base.');
    }

    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
