// Caja compartida de Ramos Mejía (08/11/2026, decisión de la usuaria): Bar (147) y Canchas (204,
// principal) usan una sola caja. Este script:
//  1. arma el grupo 'ramos' en gestion_caja_compartida (ancla: Bar, donde viven los arqueos);
//  2. trae de gestion (Supabase Ramos) los arqueos del LOCAL Ramos Mejía (localId 1, sin PDV) —los
//     10 que la migración dejó afuera— a gestion_flujo_caja_manual del Bar. No pisa uno ya cargado.
//
// Prueba (solo lee, por defecto):
//   node db/scripts/gestion-caja-compartida-ramos.js
// Aplicar:
//   node db/scripts/gestion-caja-compartida-ramos.js --aplicar --confirmo-host=<host de DATABASE_URL>
'use strict';

require('dotenv').config({ quiet: true });
const { Client } = require('pg');

const APLICAR = process.argv.includes('--aplicar');
const HOST = process.argv.find((a) => a.startsWith('--confirmo-host='))?.split('=')[1];
const BAR = 147;
const CANCHAS = 204;
const GRUPO = 'ramos';

const ssl = (url) => (/localhost|127\.0\.0\.1/.test(new URL(url).hostname) ? false : { rejectUnauthorized: false });
const abrir = async (url, soloLectura) => {
  const c = new Client({ connectionString: url, ssl: ssl(url), ...(soloLectura ? { options: '-c default_transaction_read_only=on' } : {}) });
  await c.connect();
  return c;
};

(async () => {
  const dest = process.env.DATABASE_URL;
  const orig = process.env.GESTION_RAMOS_DATABASE_URL;
  if (!dest || !orig) throw new Error('faltan DATABASE_URL y/o GESTION_RAMOS_DATABASE_URL');
  const host = new URL(dest).hostname;
  if (APLICAR && HOST !== host) throw new Error(`para aplicar, confirmá el destino: --confirmo-host=${host}`);
  console.log(`${APLICAR ? 'APLICAR' : 'PRUEBA (solo lee)'} → ${host}`);

  const g = await abrir(orig, true);
  const { rows: arqueos } = await g.query(
    `SELECT anio, mes, monto FROM flujo_caja_manual
      WHERE "localId" = 1 AND "puntoDeVentaId" IS NULL AND monto <> 0 ORDER BY anio, mes`);
  await g.end();
  console.log(`gestion: ${arqueos.length} arqueos del local Ramos Mejía`);

  const c = await abrir(dest, !APLICAR);
  const { rows: negs } = await c.query('SELECT id, name, organization_id FROM app_businesses WHERE id = ANY($1::bigint[]) ORDER BY id', [[BAR, CANCHAS]]);
  console.log('negocios:', negs.map((n) => `${n.id} ${n.name} (org ${n.organization_id})`).join(' | '));
  if (negs.length !== 2 || negs[0].organization_id !== negs[1].organization_id) throw new Error('147 y 204 tienen que existir y ser de la misma organización');
  const hayTabla = (await c.query(`SELECT to_regclass('public.gestion_caja_compartida') AS t`)).rows[0].t;
  if (!hayTabla) throw new Error('falta la tabla gestion_caja_compartida: esperá al deploy del Backend (migración 083)');

  const { rows: grupo } = await c.query('SELECT business_id, branch_id, ancla, grupo FROM gestion_caja_compartida WHERE business_id = ANY($1::bigint[])', [[BAR, CANCHAS]]);
  console.log('grupo actual:', JSON.stringify(grupo));
  const { rows: ya } = await c.query('SELECT anio, mes, monto FROM gestion_flujo_caja_manual WHERE business_id = $1 AND branch_id IS NULL', [BAR]);
  const yaK = new Map(ya.map((r) => [`${r.anio}-${r.mes}`, Number(r.monto)]));
  const nuevos = arqueos.filter((a) => !yaK.has(`${a.anio}-${a.mes}`));
  const distintos = arqueos.filter((a) => yaK.has(`${a.anio}-${a.mes}`) && Math.abs(yaK.get(`${a.anio}-${a.mes}`) - Number(a.monto)) > 0.005);
  for (const a of arqueos) {
    const k = `${a.anio}-${a.mes}`;
    const estado = !yaK.has(k) ? 'entra' : (distintos.includes(a) ? `YA HAY OTRO (${yaK.get(k)}): no se pisa` : 'ya estaba');
    console.log(`  ${a.anio}-${String(a.mes).padStart(2, '0')}  ${Number(a.monto).toLocaleString('es-AR')}  → ${estado}`);
  }
  // Canchas principal no debería tener arqueos propios: con la caja compartida se sumarían dos veces.
  const { rows: propiosCanchas } = await c.query('SELECT anio, mes, monto FROM gestion_flujo_caja_manual WHERE business_id = $1 AND branch_id IS NULL', [CANCHAS]);
  if (propiosCanchas.length) console.log(`OJO: Canchas principal tiene ${propiosCanchas.length} arqueos propios; se sumarían a los del Bar:`, JSON.stringify(propiosCanchas));

  if (!APLICAR) {
    console.log(`\nAplicaría: grupo '${GRUPO}' (Bar ancla + Canchas principal) y ${nuevos.length} arqueos al Bar.`);
    await c.end();
    return;
  }
  await c.query('BEGIN');
  try {
    await c.query(
      `INSERT INTO gestion_caja_compartida (grupo, business_id, branch_id, ancla)
       VALUES ($1, $2, NULL, true), ($1, $3, NULL, false)
       ON CONFLICT (business_id, branch_id) DO NOTHING`, [GRUPO, BAR, CANCHAS]);
    let n = 0;
    for (const a of nuevos) {
      const r = await c.query(
        `INSERT INTO gestion_flujo_caja_manual (business_id, branch_id, anio, mes, monto)
         VALUES ($1, NULL, $2, $3, $4) ON CONFLICT (business_id, branch_id, anio, mes) DO NOTHING`,
        [BAR, a.anio, a.mes, a.monto]);
      n += r.rowCount;
    }
    await c.query('COMMIT');
    console.log(`\nListo: grupo '${GRUPO}' armado, ${n} arqueos cargados al Bar.`);
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('FALLA:', e.message); process.exit(1); });
