// db/scripts/gestion-migrar-diagnostico.js
// Solo lectura. Compara mes a mes lo que hay en los Supabase de gestion contra lo que ya trajo el kit,
// para decidir desde qué fecha manda cada lado. Escribe migracion-diagnostico.txt en la carpeta actual.
//
//   node db/scripts/gestion-migrar-diagnostico.js
'use strict';

require('dotenv').config({ quiet: true });
const fs = require('fs');
const { Client } = require('pg');
const pool = require('../../config/db');

const FUENTES = [
  { nombre: 'ramos', url: process.env.GESTION_RAMOS_DATABASE_URL, pdv: { 1: [147, null], 2: [204, null], 3: [204, 15] } },
  { nombre: 'comercio', url: process.env.GESTION_COMERCIO_DATABASE_URL, pdv: { 1: [210, null] } },
];
const TABLAS = [['compras', 'gestion_compras'], ['pagos', 'gestion_pagos'], ['ventas', 'gestion_ventas']];

const salida = [];
const log = (t = '') => { salida.push(t); };
const mes = (f) => (f == null ? 'sin fecha' : new Date(f).toISOString().slice(0, 7));
const millones = (n) => (n / 1e6).toFixed(1).padStart(9);

const agregar = (mapa, clave, id, importe) => {
  if (!mapa.has(clave)) mapa.set(clave, { n: 0, total: 0, ids: new Set() });
  const x = mapa.get(clave);
  x.n += 1;
  x.total += Number(importe) || 0;
  x.ids.add(id);
};

async function columnas(cliente, tabla) {
  const { rows } = await cliente.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [tabla]);
  return new Set(rows.map((r) => r.column_name));
}

const importeDe = (cols) => (cols.has('importeManual') && cols.has('importe')
  ? 'COALESCE("importeManual", importe)'
  : (cols.has('importe') ? 'importe' : '0'));

(async () => {
  const host = new URL(process.env.DATABASE_URL).hostname;
  log(`Destino: ${host}`);
  for (const f of FUENTES) {
    if (!f.url) { log(`Sin URL para ${f.nombre}`); continue; }
    const src = new Client({ connectionString: f.url, ssl: { rejectUnauthorized: false } });
    await src.connect();
    await src.query('SET default_transaction_read_only = on');
    try {
      for (const [origen, destino] of TABLAS) {
        const ca = await columnas(src, origen);
        const cb = await columnas(pool, destino);
        const a = await src.query(`SELECT "rowId" AS id, "puntoDeVentaId" AS pdv, fecha, ${importeDe(ca)} AS importe FROM ${origen}`);
        for (const [pdv, [biz, branch]] of Object.entries(f.pdv)) {
          const gestion = new Map();
          for (const r of a.rows) if (String(r.pdv) === pdv) agregar(gestion, mes(r.fecha), r.id, r.importe);
          const b = await pool.query(
            `SELECT "rowId" AS id, fecha, ${importeDe(cb)} AS importe FROM ${destino}
              WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $2::bigint`, [biz, branch]);
          const kit = new Map();
          for (const r of b.rows) agregar(kit, mes(r.fecha), r.id, r.importe);

          log(`\n=== ${f.nombre} · ${origen} · negocio ${biz}${branch ? ` sucursal ${branch}` : ''}`);
          log(`    gestion ${a.rows.filter((r) => String(r.pdv) === pdv).length} filas / acá ${b.rows.length} filas`);
          log('    mes        gestion filas  millones |  acá filas  millones | mismo rowId');
          const meses = [...new Set([...gestion.keys(), ...kit.keys()])].sort();
          const primeroKit = meses.find((m) => kit.has(m));
          let omitidos = 0;
          let filasOmitidas = 0;
          for (const m of meses) {
            const g = gestion.get(m) ?? { n: 0, total: 0, ids: new Set() };
            const k = kit.get(m) ?? { n: 0, total: 0, ids: new Set() };
            // Lo anterior al primer dato del kit no aporta para decidir: se resume.
            if (primeroKit && m < primeroKit) { omitidos += 1; filasOmitidas += g.n; continue; }
            if (omitidos) { log(`    (${omitidos} meses anteriores, ${filasOmitidas} filas de gestion, sin nada acá)`); omitidos = 0; }
            let comunes = 0;
            for (const id of g.ids) if (k.ids.has(id)) comunes += 1;
            log(`    ${m.padEnd(10)} ${String(g.n).padStart(13)} ${millones(g.total)} | ${String(k.n).padStart(10)} ${millones(k.total)} | ${String(comunes).padStart(11)}`);
          }
        }
      }
    } finally {
      await src.end();
    }
  }
  fs.writeFileSync('migracion-diagnostico.txt', `${salida.join('\n')}\n`, 'utf8');
  console.log('Listo: migracion-diagnostico.txt (no se escribió nada en ninguna base)');
})().catch((e) => {
  console.error('FALLA:', e.message);
  process.exitCode = 1;
}).finally(() => pool.end());
