// Detalle de ventas de un día o de un mes para la versión celular (Diego 08/11/2026, mockup_mes_dia):
// total y comparación, turnos, servicio, formas de cobro, mozos, descuentos, pagos desde la caja,
// la tira de días del mes y, de las ventas por artículo, rubros/subrubros y top 10.
//
// - Un lugar por pedido (?sucursal como el resto); el celular suma los PDV elegidos.
// - ?dia=AAAA-MM-DD o ?mes=AAAA-MM; sin ninguno, el último día con todo cargado (ventas y artículos).
// - ?turno filtra lo que sale de la caja (22). Los artículos no tienen turno: van siempre por día entero.
// - El descuento viene una sola vez por ticket (en la fila que lleva el total), así que se suma sin duplicar.
'use strict';

const { sql, db } = require('../db');
const { filtroSucursalSql } = require('./query-builders');
const { ErrorDatos } = require('./resultados-api');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const sumarDias = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const finDeMes = (anio, mes) => iso(new Date(Date.UTC(anio, mes, 0)));

// Ventas por artículo del lugar: la principal en sales_daily_items (branch NULL), cada sucursal en
// sales_daily_items_branch. «Todas» = las dos.
function articulosSql(businessId, sucursal) {
  const ppal = sql`SELECT s.business_id, s.day, s.article_id, s.article_name, s.qty, s.amount
                     FROM sales_daily_items s WHERE s.business_id = ${businessId} AND s.branch_id IS NULL`;
  const suc = (cond) => sql`SELECT s.business_id, s.day, s.article_id, s.article_name, s.qty, s.amount
                     FROM sales_daily_items_branch s WHERE s.business_id = ${businessId} AND ${cond}`;
  if (sucursal === null) return ppal;
  if (sucursal !== undefined) return suc(sql`s.branch_id = ${sucursal}`);
  return sql`${ppal} UNION ALL ${suc(sql`true`)}`;
}

async function obtenerDetalleVentas({ organizationId, businessId, sucursal, sp }) {
  const diaP = sp.get('dia');
  const mesP = sp.get('mes');
  const turno = (sp.get('turno') || '').trim() || null;
  if (diaP && !ISO.test(diaP)) throw new ErrorDatos('Día inválido');
  if (mesP && !MES.test(mesP)) throw new ErrorDatos('Mes inválido');

  const lugarV = filtroSucursalSql('v', businessId, sucursal);
  const art = articulosSql(businessId, sucursal);
  const [ult, ultArt] = await Promise.all([
    db.one(sql`SELECT to_char(MAX(v.fecha)::date, 'YYYY-MM-DD') AS d FROM gestion_ventas v WHERE ${lugarV}`),
    db.one(sql`SELECT to_char(MAX(a.day)::date, 'YYYY-MM-DD') AS d FROM (${art}) a`),
  ]);
  const ultimoDia = ult?.d ?? null;
  const ultimoArticulos = ultArt?.d ?? null;
  // Último día con todo cargado: los artículos suelen llegar un día después que la caja.
  const ultimoCompleto = ultimoDia && ultimoArticulos && ultimoArticulos < ultimoDia ? ultimoArticulos : ultimoDia;
  if (!ultimoDia) return { vacio: true, ultimoDia: null };

  let tipo; let desde; let hasta;
  if (mesP) {
    tipo = 'mes';
    const [a, m] = mesP.split('-').map(Number);
    desde = `${mesP}-01`; hasta = finDeMes(a, m);
  } else {
    tipo = 'dia';
    desde = hasta = diaP || ultimoCompleto;
  }
  const hastaExcl = sumarDias(hasta, 1);
  const enRango = (d, h) => sql`v.fecha >= ${d}::date AND v.fecha < ${h}::date`;
  const condTurno = turno ? sql`AND TRIM(v.turno) = ${turno}` : sql``;
  const imp = sql`COALESCE(v."importeManual", v.importe)`;
  const cub = sql`COALESCE(NULLIF(regexp_replace(COALESCE(v.cub::text, ''), '[^0-9]', '', 'g'), '')::int, 0)`;
  const base = sql`FROM gestion_ventas v WHERE ${lugarV} AND ${enRango(desde, hastaExcl)} ${condTurno}`;

  // Comparación: un día contra el promedio de los últimos 4 iguales (mismo día de la semana, con
  // ventas); un mes contra el anterior (si el mes está en curso, hasta el mismo día).
  const mesDe = desde.slice(0, 7);
  const [aM, mM] = mesDe.split('-').map(Number);
  const enCurso = tipo === 'mes' && ultimoDia >= desde && ultimoDia <= hasta;
  const compQ = tipo === 'dia'
    ? db.many(sql`
        SELECT v.fecha::date AS d, SUM(${imp})::float8 AS t FROM gestion_ventas v
         WHERE ${lugarV} ${condTurno} AND v.fecha < ${desde}::date AND v.fecha >= (${desde}::date - 63)
           AND EXTRACT(DOW FROM v.fecha) = EXTRACT(DOW FROM ${desde}::date)
         GROUP BY 1 HAVING SUM(${imp}) > 0 ORDER BY 1 DESC LIMIT 4`)
    : (() => {
        const ant = new Date(Date.UTC(aM, mM - 2, 1));
        const dAnt = iso(ant);
        const finAnt = finDeMes(ant.getUTCFullYear(), ant.getUTCMonth() + 1);
        const corte = enCurso ? sumarDias(dAnt, Math.min(Number(ultimoDia.slice(8)), Number(finAnt.slice(8))) ) : sumarDias(finAnt, 1);
        return db.many(sql`SELECT SUM(${imp})::float8 AS t, ${dAnt} AS desde, ${corte} AS hasta FROM gestion_ventas v
                           WHERE ${lugarV} ${condTurno} AND ${enRango(dAnt, corte)}`);
      })();

  const [tot, turnos, servicio, cobro, mozos, dtoTurno, dias, comp, pagos] = await Promise.all([
    db.one(sql`SELECT SUM(${imp})::float8 AS total, COUNT(DISTINCT (v.fecha::date, v.comprobant))::int AS tickets,
                      SUM(${cub})::int AS cubiertos, SUM(COALESCE(v.descuento, 0))::float8 AS descuento,
                      COUNT(DISTINCT (v.fecha::date, v.comprobant)) FILTER (WHERE COALESCE(v.descuento, 0) <> 0)::int AS con_dto
               ${base}`),
    db.many(sql`SELECT COALESCE(NULLIF(TRIM(v.turno), ''), '—') AS turno, SUM(${imp})::float8 AS importe,
                       COUNT(DISTINCT (v.fecha::date, v.comprobant))::int AS tickets
                FROM gestion_ventas v WHERE ${lugarV} AND ${enRango(desde, hastaExcl)} GROUP BY 1 ORDER BY 2 DESC`),
    db.many(sql`SELECT COALESCE(NULLIF(TRIM(v.tipo), ''), '—') AS tipo, SUM(${imp})::float8 AS importe,
                       COUNT(DISTINCT (v.fecha::date, v.comprobant))::int AS tickets, SUM(${cub})::int AS cubiertos
                ${base} GROUP BY 1 ORDER BY 2 DESC`),
    db.many(sql`SELECT COALESCE(NULLIF(TRIM(v.cobro), ''), '—') AS cobro, SUM(${imp})::float8 AS importe, COUNT(*)::int AS n
                ${base} GROUP BY 1 ORDER BY 2 DESC`),
    db.many(sql`SELECT COALESCE(NULLIF(TRIM(v.mozo), ''), '—') AS mozo, SUM(${imp})::float8 AS importe,
                       COUNT(DISTINCT (v.fecha::date, v.comprobant))::int AS tickets
                ${base} GROUP BY 1 ORDER BY 2 DESC`),
    db.many(sql`SELECT COALESCE(NULLIF(TRIM(v.turno), ''), '—') AS turno, SUM(COALESCE(v.descuento, 0))::float8 AS importe
                ${base} GROUP BY 1 HAVING SUM(COALESCE(v.descuento, 0)) <> 0 ORDER BY 2 DESC`),
    db.many(sql`SELECT to_char(v.fecha::date, 'YYYY-MM-DD') AS fecha, SUM(${imp})::float8 AS importe
                FROM gestion_ventas v WHERE ${lugarV} ${condTurno}
                 AND ${enRango(`${mesDe}-01`, sumarDias(finDeMes(aM, mM), 1))} GROUP BY 1 ORDER BY 1`),
    compQ,
    // Pagos hechos con la caja del día (gastos varios y sueldos con caja «CAJA»; Caja mayor y Bancos no).
    db.many(sql`SELECT TRIM(COALESCE(c.concepto, '')) AS concepto, TRIM(COALESCE(c.proveedor, '')) AS proveedor,
                       COALESCE(c."importeManual", c.importe)::float8 AS importe, to_char(c."fechaPago"::date, 'YYYY-MM-DD') AS fecha
                FROM gestion_compras c
                WHERE ${filtroSucursalSql('c', businessId, sucursal)} AND UPPER(TRIM(c."cajaPago")) = 'CAJA'
                  AND c."fechaPago" >= ${desde}::date AND c."fechaPago" < ${hastaExcl}::date
                ORDER BY 3 DESC`),
  ]);

  let comparacion = null;
  if (tipo === 'dia') {
    if (comp.length) comparacion = { tipo: 'dias', valor: r2(comp.reduce((s, x) => s + x.t, 0) / comp.length), n: comp.length };
  } else if (comp[0]?.t) {
    comparacion = { tipo: 'mes', valor: r2(comp[0].t), hastaDia: enCurso ? Number(ultimoDia.slice(8)) : null };
  }

  // Artículos (sin turno). Rubro y subrubro del maestro de artículos de la organización.
  const desdeArt = desde; const hastaArt = hastaExcl;
  const filasArt = await db.many(sql`
    WITH a AS (SELECT * FROM (${art}) x WHERE x.day >= ${desdeArt}::date AND x.day < ${hastaArt}::date)
    SELECT COALESCE(NULLIF(TRIM(m.categoria), ''), 'Sin rubro') AS rubro, COALESCE(NULLIF(TRIM(m.subrubro), ''), '—') AS subrubro,
           TRIM(COALESCE(m.nombre, a.article_name, a.article_id::text)) AS nombre,
           SUM(a.amount)::float8 AS importe, SUM(a.qty)::float8 AS unidades
      FROM a
      LEFT JOIN LATERAL (
        SELECT mm.categoria, mm.subrubro, mm.nombre FROM maxi_articles mm
         WHERE mm.articulo_id = a.article_id
           AND mm.business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId})
         ORDER BY (mm.business_id = a.business_id) DESC LIMIT 1) m ON true
     GROUP BY 1, 2, 3`);
  const agrupar = (claveDe) => {
    const mapa = new Map();
    for (const f of filasArt) {
      const k = claveDe(f);
      const x = mapa.get(k.id) ?? { ...k.datos, importe: 0, unidades: 0 };
      x.importe += f.importe; x.unidades += f.unidades;
      mapa.set(k.id, x);
    }
    return [...mapa.values()].map((x) => ({ ...x, importe: r2(x.importe), unidades: r2(x.unidades) }))
      .filter((x) => Math.abs(x.importe) >= 0.01).sort((a, b) => b.importe - a.importe);
  };
  const articulos = filasArt.length ? {
    rubros: agrupar((f) => ({ id: f.rubro, datos: { rubro: f.rubro } })),
    subrubros: agrupar((f) => ({ id: `${f.rubro}|${f.subrubro}`, datos: { rubro: f.rubro, subrubro: f.subrubro } })),
    topImporte: [...filasArt].filter((f) => f.importe > 0).sort((a, b) => b.importe - a.importe).slice(0, 10)
      .map((f) => ({ nombre: f.nombre, importe: r2(f.importe), unidades: r2(f.unidades) })),
    // Por unidades no cuenta lo que va a $ 0 dentro de un combo (cubierto, papas…).
    topUnidades: [...filasArt].filter((f) => f.importe > 0).sort((a, b) => b.unidades - a.unidades || b.importe - a.importe).slice(0, 10)
      .map((f) => ({ nombre: f.nombre, importe: r2(f.importe), unidades: r2(f.unidades) })),
    total: r2(filasArt.reduce((s, f) => s + f.importe, 0)),
  } : null;

  return {
    periodo: { tipo, desde, hasta, turno },
    ultimoDia, ultimoCompleto, ultimoArticulos,
    total: r2(tot?.total), tickets: tot?.tickets ?? 0, cubiertos: tot?.cubiertos ?? 0,
    bruto: r2((tot?.total ?? 0) + (tot?.descuento ?? 0)),
    comparacion,
    turnos: turnos.map((t) => ({ turno: t.turno, importe: r2(t.importe), tickets: t.tickets })),
    servicio: servicio.map((s) => ({ tipo: s.tipo, importe: r2(s.importe), tickets: s.tickets, cubiertos: s.cubiertos })),
    cobro: cobro.map((c) => ({ cobro: c.cobro, importe: r2(c.importe), n: c.n })),
    mozos: mozos.map((m) => ({ mozo: m.mozo, importe: r2(m.importe), tickets: m.tickets })),
    descuentos: { importe: r2(tot?.descuento), tickets: tot?.con_dto ?? 0, porTurno: dtoTurno.map((d) => ({ turno: d.turno, importe: r2(d.importe) })) },
    pagosCaja: pagos.map((p) => ({ concepto: p.concepto, proveedor: p.proveedor, importe: r2(p.importe), fecha: p.fecha })),
    dias: dias.map((d) => ({ fecha: d.fecha, importe: r2(d.importe) })),
    articulos,
  };
}

module.exports = { obtenerDetalleVentas };
