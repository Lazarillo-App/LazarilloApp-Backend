// db/scripts/gestion-chequeo-apagado.js
// Chequeo de SOLO LECTURA antes de apagar lazarillo_gestion: compara, por lugar y mes, lo que hay en
// los Supabase de gestion contra lo que hay acá. gestion y Lazarillo leen el MISMO kit (actualizador):
// si gestion tiene un dato de MaxiRest que acá no está, es un problema de nuestra lectura, no del kit.
//
// Corre en la PC de la usuaria (las URL de gestion están solo en su .env local):
//   node db/scripts/gestion-chequeo-apagado.js [desde YYYY-MM]   (default 2026-01)
//
// Muestra:
//  1. Último dato de cada lugar en cada lado (compras y ventas).
//  2. Meses con diferencias en compras distribuidas (lo que ve el Panel, importe corregido) y en ventas.
//  3. Los dos casos que quedaron preguntados a Diego: IVA de Comercio Z085719012026 y retiros de San Justo 30/10.
'use strict';

require('dotenv').config({ quiet: true });
const { Client } = require('pg');

const DESDE = (process.argv[2] || '2026-01') + '-01';
const LUGARES = {
  ramos: { url: 'GESTION_RAMOS_DATABASE_URL', pdv: { 1: [147, null, 'Bar'], 2: [204, null, 'Canchas Ramos'], 3: [204, 15, 'San Justo'] } },
  comercio: { url: 'GESTION_COMERCIO_DATABASE_URL', pdv: { 1: [210, null, 'Comercio'] } },
};

const ssl = (url) => (/localhost|127\.0\.0\.1/.test(new URL(url).hostname) ? false : { rejectUnauthorized: false });
async function abrir(url) {
  const c = new Client({ connectionString: url, ssl: ssl(url), options: '-c default_transaction_read_only=on', query_timeout: 180000 });
  await c.connect();
  return c;
}
const num = (v) => (v == null ? 0 : Number(v));
const fmt = (v) => Math.round(num(v)).toLocaleString('es-AR');

// Por mes y lugar: filas e importe. En gestion el lugar es el PDV; acá, negocio + sucursal.
const SQL_GESTION = {
  compras: `SELECT "puntoDeVentaId"::text AS pdv, to_char(fecha, 'YYYY-MM') AS mes, count(*)::int AS n,
                   sum(COALESCE("importeManual", importe))::text AS imp
              FROM v_compras_distribuidas WHERE fecha >= $1::date GROUP BY 1, 2`,
  ventas: `SELECT "puntoDeVentaId"::text AS pdv, to_char(fecha, 'YYYY-MM') AS mes, count(*)::int AS n, sum(importe)::text AS imp
             FROM ventas WHERE fecha >= $1::date GROUP BY 1, 2`,
};
const SQL_ACA = {
  compras: `SELECT business_id::text AS b, branch_id::text AS s, to_char(fecha, 'YYYY-MM') AS mes, count(*)::int AS n,
                   sum(COALESCE("importeManual", importe))::text AS imp
              FROM gestion_v_compras_distribuidas WHERE fecha >= $1::date AND business_id = ANY($2::bigint[]) GROUP BY 1, 2, 3`,
  ventas: `SELECT business_id::text AS b, branch_id::text AS s, to_char(fecha, 'YYYY-MM') AS mes, count(*)::int AS n, sum(importe)::text AS imp
             FROM gestion_ventas WHERE fecha >= $1::date AND business_id = ANY($2::bigint[]) GROUP BY 1, 2, 3`,
};

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('falta DATABASE_URL');
  const aca = await abrir(process.env.DATABASE_URL);
  console.log(`Chequeo desde ${DESDE.slice(0, 7)} → acá: ${new URL(process.env.DATABASE_URL).hostname} (solo lectura)\n`);

  for (const [nombre, f] of Object.entries(LUGARES)) {
    const url = process.env[f.url];
    if (!url) { console.log(`(${nombre}: falta ${f.url}, se saltea)`); continue; }
    const g = await abrir(url);
    const negocios = [...new Set(Object.values(f.pdv).map((p) => p[0]))];
    const claveAca = (b, s) => Object.entries(f.pdv).find(([, p]) => String(p[0]) === b && String(p[1] ?? '') === String(s ?? ''))?.[0];
    console.log(`════════ ${nombre.toUpperCase()} ════════`);

    // 1. Último dato de cada lado.
    for (const t of ['compras', 'ventas']) {
      const ultG = (await g.query(`SELECT "puntoDeVentaId"::text AS pdv, max(fecha)::date::text AS f FROM ${t} WHERE fecha <= now() + interval '1 day' GROUP BY 1`)).rows;
      const ultA = (await aca.query(`SELECT business_id::text AS b, branch_id::text AS s, max(fecha)::date::text AS f FROM gestion_${t}
                                      WHERE business_id = ANY($1::bigint[]) AND fecha <= now() + interval '1 day' GROUP BY 1, 2`, [negocios])).rows;
      for (const [pdv, [, , etiqueta]] of Object.entries(f.pdv)) {
        const fg = ultG.find((r) => r.pdv === pdv)?.f ?? '';
        const fa = ultA.find((r) => claveAca(r.b, r.s) === pdv)?.f ?? '';
        const marca = fg === fa ? '' : (fg > fa ? '   ← gestion tiene días que acá no' : '   ← acá hay días que gestion no');
        console.log(`  último ${t.padEnd(7)} ${etiqueta.padEnd(14)} gestion ${(fg || '—').padEnd(10)}   acá ${(fa || '—').padEnd(10)}${marca}`);
      }
    }

    // 2. Diferencias por mes.
    for (const t of ['compras', 'ventas']) {
      const mapa = new Map();
      for (const r of (await g.query(SQL_GESTION[t], [DESDE])).rows) mapa.set(`${r.pdv}|${r.mes}`, { g: r });
      for (const r of (await aca.query(SQL_ACA[t], [DESDE, negocios])).rows) {
        const pdv = claveAca(r.b, r.s);
        if (!pdv) continue;
        const k = `${pdv}|${r.mes}`;
        mapa.set(k, { ...(mapa.get(k) ?? {}), a: r });
      }
      const difs = [...mapa.entries()].sort(([a], [b]) => a.localeCompare(b))
        .filter(([, v]) => Math.abs(num(v.g?.imp) - num(v.a?.imp)) >= 1);
      console.log(`\n  ${t === 'compras' ? 'Compras distribuidas (importe corregido)' : 'Ventas'}: ${difs.length ? `${difs.length} meses con diferencia` : 'iguales en todos los meses'}`);
      for (const [k, v] of difs) {
        const [pdv, mes] = k.split('|');
        const d = num(v.a?.imp) - num(v.g?.imp);
        console.log(`    ${mes}  ${f.pdv[pdv][2].padEnd(14)} gestion ${fmt(v.g?.imp).padStart(15)} (${v.g?.n ?? 0} filas)   acá ${fmt(v.a?.imp).padStart(15)} (${v.a?.n ?? 0} filas)   dif ${d > 0 ? '+' : ''}${fmt(d)}`);
      }
    }

    // 3. Preguntas abiertas a Diego.
    if (nombre === 'comercio') {
      const sql = (tabla) => `SELECT "rowId", fecha::date::text AS fecha, "conceptoCodigo", "conceptoCodigoManual", proveedor, comprobante, importe::text, "importeManual"::text, observac
                                FROM ${tabla} WHERE concat_ws(' ', comprobante, detalle, observac, "rowId") ILIKE '%Z085719012026%' ORDER BY fecha`;
      console.log('\n  IVA Z085719012026 (Comercio)');
      console.log('    gestion:', JSON.stringify((await g.query(sql('compras'))).rows));
      console.log('    acá:    ', JSON.stringify((await aca.query(sql('gestion_compras'))).rows));
    } else {
      console.log('\n  San Justo: compras del 30/10/2026 (retiros)');
      const cols = `"rowId", "conceptoCodigo", "conceptoCodigoManual", concepto, detalle, importe::text, "importeManual"::text, observac`;
      const fg = (await g.query(`SELECT ${cols} FROM compras WHERE "puntoDeVentaId" = 3 AND fecha::date = '2026-10-30' ORDER BY "rowId"`)).rows;
      const fa = (await aca.query(`SELECT ${cols} FROM gestion_compras WHERE business_id = 204 AND branch_id = 15 AND fecha::date = '2026-10-30' ORDER BY "rowId"`)).rows;
      const ka = new Set(fa.map((r) => r.rowId));
      const kg = new Set(fg.map((r) => r.rowId));
      console.log(`    gestion ${fg.length} filas, acá ${fa.length}`);
      for (const r of fg.filter((x) => !ka.has(x.rowId))) console.log('    solo en gestion:', JSON.stringify(r));
      for (const r of fa.filter((x) => !kg.has(x.rowId))) console.log('    solo acá:       ', JSON.stringify(r));
      for (const r of fa.filter((x) => /retir/i.test(`${x.concepto} ${x.detalle} ${x.observac}`))) console.log('    retiro (acá):', JSON.stringify(r));
    }
    console.log('');
    await g.end();
  }
  await aca.end();
})().catch((e) => { console.error('FALLA:', e.message); process.exit(1); });
