// db/scripts/gestion-chequeo-detalle.js
// Abre un mes que gestion-chequeo-apagado.js marcó con diferencia: fila por fila (y día por día) qué
// hay en gestion (Supabase) y qué hay acá. SOLO LECTURA en los dos lados.
//
//   node db/scripts/gestion-chequeo-detalle.js <ramos|comercio> <pdv> <YYYY-MM> <compras|ventas>
//   pdv: ramos 1 = Bar, 2 = Canchas Ramos, 3 = San Justo · comercio 1 = Comercio
//   ej.: node db/scripts/gestion-chequeo-detalle.js comercio 1 2026-09 compras
'use strict';

require('dotenv').config({ quiet: true });
const { Client } = require('pg');

const LUGARES = {
  ramos: { url: 'GESTION_RAMOS_DATABASE_URL', pdv: { 1: [147, null], 2: [204, null], 3: [204, 15] } },
  comercio: { url: 'GESTION_COMERCIO_DATABASE_URL', pdv: { 1: [210, null] } },
};
const [inst, pdv, mes, tabla] = process.argv.slice(2);
const f = LUGARES[inst];
if (!f || !f.pdv[pdv] || !/^\d{4}-\d{2}$/.test(mes ?? '') || !['compras', 'ventas'].includes(tabla)) {
  console.log('Uso: node db/scripts/gestion-chequeo-detalle.js <ramos|comercio> <pdv> <YYYY-MM> <compras|ventas>');
  process.exit(1);
}
const [biz, suc] = f.pdv[pdv];
const desde = `${mes}-01`;
const ssl = (url) => (/localhost|127\.0\.0\.1/.test(new URL(url).hostname) ? false : { rejectUnauthorized: false });
const abrir = async (url) => {
  const c = new Client({ connectionString: url, ssl: ssl(url), options: '-c default_transaction_read_only=on', query_timeout: 180000 });
  await c.connect();
  return c;
};
const num = (v) => (v == null ? 0 : Number(v));
const fmt = (v) => Math.round(num(v)).toLocaleString('es-AR');
const corto = (s, n = 34) => String(s ?? '').trim().slice(0, n);

const COMPRAS = (vista, donde) => `
  SELECT "rowId" || COALESCE('#' || "distribucionId", '') AS k, fecha::date::text AS fecha, proveedor, concepto, comprobante,
         importe::text AS importe, "importeManual"::text AS manual, COALESCE("importeManual", importe)::text AS ef
    FROM ${vista} WHERE ${donde} AND fecha >= $1::date AND fecha < ($1::date + interval '1 month')`;
const VENTAS = (t, donde) => `
  SELECT "rowId" AS k, fecha::date::text AS fecha, NULL AS proveedor, NULL AS concepto, NULL AS comprobante,
         importe::text AS importe, NULL AS manual, importe::text AS ef
    FROM ${t} WHERE ${donde} AND fecha >= $1::date AND fecha < ($1::date + interval '1 month')`;

(async () => {
  const g = await abrir(process.env[f.url]);
  const a = await abrir(process.env.DATABASE_URL);
  const filasG = (await g.query(tabla === 'compras'
    ? COMPRAS('v_compras_distribuidas', `"puntoDeVentaId" = ${Number(pdv)}`)
    : VENTAS('ventas', `"puntoDeVentaId" = ${Number(pdv)}`), [desde])).rows;
  const filtroAca = `business_id = ${biz} AND branch_id ${suc == null ? 'IS NULL' : `= ${suc}`}`;
  const filasA = (await a.query(tabla === 'compras'
    ? COMPRAS('gestion_v_compras_distribuidas', filtroAca)
    : VENTAS('gestion_ventas', filtroAca), [desde])).rows;
  await g.end(); await a.end();

  const total = (fs) => fs.reduce((s, x) => s + num(x.ef), 0);
  console.log(`${inst} pdv ${pdv} · ${mes} · ${tabla}: gestion ${fmt(total(filasG))} (${filasG.length}) · acá ${fmt(total(filasA))} (${filasA.length}) · dif ${fmt(total(filasA) - total(filasG))}\n`);

  // Por día: ubica dónde está la diferencia aunque los rowId no coincidan.
  const porDia = new Map();
  for (const [lado, fs] of [['g', filasG], ['a', filasA]]) for (const x of fs) {
    const d = porDia.get(x.fecha) ?? { g: 0, a: 0, ng: 0, na: 0 };
    d[lado] += num(x.ef); d[`n${lado}`] += 1;
    porDia.set(x.fecha, d);
  }
  const dias = [...porDia.entries()].sort().filter(([, d]) => Math.abs(d.a - d.g) >= 1);
  console.log(`Días con diferencia: ${dias.length}`);
  for (const [dia, d] of dias) console.log(`  ${dia}  gestion ${fmt(d.g).padStart(13)} (${d.ng})   acá ${fmt(d.a).padStart(13)} (${d.na})   dif ${fmt(d.a - d.g)}`);

  // Fila por fila (mismo rowId en los dos lados).
  const mg = new Map(filasG.map((x) => [x.k, x]));
  const ma = new Map(filasA.map((x) => [x.k, x]));
  const linea = (x) => `${x.fecha}  ${fmt(x.ef).padStart(13)}${x.manual != null ? ` (manual; informe ${fmt(x.importe)})` : ''}  ${corto(x.proveedor, 24)}  ${corto(x.concepto, 24)}  ${x.comprobante ?? ''}  ${x.k}`;
  const soloG = filasG.filter((x) => !ma.has(x.k)).sort((p, q) => Math.abs(num(q.ef)) - Math.abs(num(p.ef)));
  const soloA = filasA.filter((x) => !mg.has(x.k)).sort((p, q) => Math.abs(num(q.ef)) - Math.abs(num(p.ef)));
  const distintas = filasA.filter((x) => mg.has(x.k) && Math.abs(num(x.ef) - num(mg.get(x.k).ef)) >= 1);
  console.log(`\nSolo en gestion: ${soloG.length} filas, ${fmt(total(soloG))}`);
  for (const x of soloG.slice(0, 30)) console.log('  ' + linea(x));
  console.log(`\nSolo acá: ${soloA.length} filas, ${fmt(total(soloA))}`);
  for (const x of soloA.slice(0, 30)) console.log('  ' + linea(x));
  console.log(`\nMisma fila, distinto importe: ${distintas.length}`);
  for (const x of distintas.slice(0, 30)) console.log(`  acá     ${linea(x)}\n  gestion ${linea(mg.get(x.k))}`);
})().catch((e) => { console.error('FALLA:', e.message); process.exit(1); });
