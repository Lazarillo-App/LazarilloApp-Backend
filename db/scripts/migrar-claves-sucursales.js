// db/scripts/migrar-claves-sucursales.js
//
// Ajusta dos claves únicas de prod para que los pipelines de Maxi puedan
// escribir más de un pdv por negocio (FCSANJUSTO = sucursal 15 del 204):
//
//  1) sales_daily_items: hay un único (business_id, day, article_id) SIN
//     sucursal (sales_daily_items_pkey) que rechaza el mismo artículo el mismo
//     día en dos sucursales. Se saca; queda idx_sales_daily_items_unique
//     (business_id, day, article_id, COALESCE(branch_id, 0)), que ya existe.
//  2) purchase_payments: único (business_id, orden_maxi). orden_maxi es la
//     numeración de cada PC de MaxiRest y entre FCRAMOS y FCSANJUSTO se
//     repite (250 órdenes en 2025+2026). Pasa a (business_id, pdv, orden_maxi).
//
// Ninguna fila se toca: solo índices/constraints, en una transacción.
// DRY-RUN por defecto. Correr ANTES de sincronizar el 204 con los pipelines.
//
// Uso: node db/scripts/migrar-claves-sucursales.js [--aplicar]
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function constraintODeIndice(client, tabla, nombre) {
  const { rows } = await client.query(
    `SELECT contype, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = $1::regclass AND conname = $2`,
    [tabla, nombre]
  );
  if (rows.length) return { tipo: rows[0].contype === 'p' ? 'PRIMARY KEY' : 'UNIQUE constraint', def: rows[0].def };
  const { rows: idx } = await client.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 AND indexname = $2`,
    [tabla, nombre]
  );
  return idx.length ? { tipo: 'índice', def: idx[0].indexdef } : null;
}

async function sacar(client, tabla, nombre, actual) {
  if (!actual) return;
  if (actual.tipo === 'índice') await client.query(`DROP INDEX IF EXISTS "${nombre}"`);
  else await client.query(`ALTER TABLE ${tabla} DROP CONSTRAINT IF EXISTS "${nombre}"`);
}

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  console.log(aplicar ? 'APLICANDO\n' : 'DRY-RUN (no se cambia nada)\n');

  const client = await pool.connect();
  try {
    // --- chequeos previos ---
    const pkSdi = await constraintODeIndice(client, 'sales_daily_items', 'sales_daily_items_pkey');
    const conSucursal = await constraintODeIndice(client, 'sales_daily_items', 'idx_sales_daily_items_unique');
    console.log('sales_daily_items_pkey        :', pkSdi ? `${pkSdi.tipo} — ${pkSdi.def}` : '(no existe)');
    console.log('idx_sales_daily_items_unique  :', conSucursal ? conSucursal.def : '(no existe)');

    const { rows: idInfo } = await client.query(
      `SELECT COUNT(*)::int AS filas, COUNT(id)::int AS con_id, COUNT(DISTINCT id)::int AS ids_distintos
         FROM sales_daily_items`
    );
    const idSirveDePk = idInfo[0].filas === idInfo[0].con_id && idInfo[0].con_id === idInfo[0].ids_distintos;
    console.log('sales_daily_items.id          :', idInfo[0], idSirveDePk ? '→ sirve como PK' : '→ NO sirve como PK');

    const ppViejo = await constraintODeIndice(client, 'purchase_payments', 'purchase_payments_business_id_orden_maxi_key');
    console.log('purchase_payments (viejo)     :', ppViejo ? `${ppViejo.tipo} — ${ppViejo.def}` : '(no existe)');
    const { rows: sinPdv } = await client.query(`SELECT COUNT(*)::int AS n FROM purchase_payments WHERE pdv IS NULL`);
    console.log('purchase_payments sin pdv     :', sinPdv[0].n);

    if (!conSucursal) {
      throw new Error('Falta idx_sales_daily_items_unique: sacar el pkey dejaría sales_daily_items sin único. Abortado.');
    }
    if (sinPdv[0].n > 0) {
      console.log('  (aviso: filas sin pdv no quedan cubiertas por el único nuevo — revisar a mano)');
    }

    if (!aplicar) {
      console.log('\nSe haría:');
      if (pkSdi) console.log(`  - sacar sales_daily_items_pkey (${pkSdi.tipo})`);
      if (pkSdi?.tipo === 'PRIMARY KEY' && idSirveDePk) console.log('  - PRIMARY KEY (id) en sales_daily_items');
      console.log('  - crear único purchase_payments (business_id, pdv, orden_maxi)');
      if (ppViejo) console.log('  - sacar purchase_payments_business_id_orden_maxi_key');
      console.log('\nAgregá --aplicar para ejecutarlo.');
      return;
    }

    await client.query('BEGIN');
    await sacar(client, 'sales_daily_items', 'sales_daily_items_pkey', pkSdi);
    if (pkSdi?.tipo === 'PRIMARY KEY' && idSirveDePk) {
      await client.query(`ALTER TABLE sales_daily_items ADD CONSTRAINT sales_daily_items_pkey PRIMARY KEY (id)`);
    }
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS purchase_payments_biz_pdv_orden_uq
         ON purchase_payments (business_id, pdv, orden_maxi)`
    );
    await sacar(client, 'purchase_payments', 'purchase_payments_business_id_orden_maxi_key', ppViejo);
    await client.query('COMMIT');
    console.log('\nOK — claves ajustadas.');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
