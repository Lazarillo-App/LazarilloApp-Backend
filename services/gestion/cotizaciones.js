// Cotizaciones del dólar (Diego 19/11/2026): un gasto pactado en US$ (el alquiler, en dólares billete
// comprados al blue) se debita en pesos. Al cargarlo se sugiere el dólar de referencia del día;
// el usuario lo puede cambiar por lo que pagó de verdad.
// Fuentes públicas y gratuitas, sin conector: DolarApi (el valor de hoy) y ArgentinaDatos (la
// historia, una sola vez). Se guardan en gestion_cotizaciones y valen para todos los negocios.
// Si las fuentes no responden, no se sugiere nada y el usuario carga el dólar a mano.
'use strict';

const { sql, db } = require('./db');

const TIPOS = { blue: 'blue', oficial: 'oficial', mep: 'bolsa' }; // tipo de Lazarillo → «casa» de las fuentes
const NOMBRE = { blue: 'blue', oficial: 'oficial BNA', mep: 'MEP' };
const TIMEOUT = 6000;

const hoyAR = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

async function traerJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function guardar(filas, fuente) {
  const ok = filas.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.fecha) && num(f.venta) > 0);
  if (!ok.length) return;
  await db.execute(sql`
    INSERT INTO gestion_cotizaciones (tipo, fecha, compra, venta, fuente)
    SELECT * FROM unnest(${ok.map((f) => f.tipo)}::text[], ${ok.map((f) => f.fecha)}::date[],
                         ${ok.map((f) => num(f.compra))}::numeric[], ${ok.map((f) => num(f.venta))}::numeric[],
                         ${ok.map(() => fuente)}::text[])
    ON CONFLICT (tipo, fecha) DO UPDATE SET compra = EXCLUDED.compra, venta = EXCLUDED.venta, fuente = EXCLUDED.fuente`);
}

// El de hoy: DolarApi.
async function traerHoy(tipo) {
  const d = await traerJson(`https://dolarapi.com/v1/dolares/${TIPOS[tipo]}`);
  await guardar([{ tipo, fecha: hoyAR(), compra: d.compra, venta: d.venta }], 'dolarapi');
}

// La historia completa de ese tipo: ArgentinaDatos (una vez; después alcanza con la tabla).
async function traerHistoria(tipo) {
  const d = await traerJson(`https://api.argentinadatos.com/v1/cotizaciones/dolares/${TIPOS[tipo]}`);
  if (!Array.isArray(d)) return;
  await guardar(d.map((x) => ({ tipo, fecha: String(x.fecha ?? '').slice(0, 10), compra: x.compra, venta: x.venta })), 'argentinadatos');
}

const leer = (tipo, fecha) => db.one(sql`
  SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, compra::float8 AS compra, venta::float8 AS venta
  FROM gestion_cotizaciones WHERE tipo = ${tipo} AND fecha <= ${fecha}::date AND fecha >= ${fecha}::date - 7
  ORDER BY fecha DESC LIMIT 1`);

/**
 * GET /cotizacion?tipo=blue&fecha=YYYY-MM-DD → { tipo, nombre, fecha, venta, compra } del día (o el
 * último hábil antes). { disponible: false } si no se pudo saber.
 */
async function obtenerCotizacion({ sp }) {
  const tipo = String(sp.get('tipo') || 'blue');
  if (!TIPOS[tipo]) throw Object.assign(new Error('Tipo de dólar inválido'), { status: 400 });
  const hoy = hoyAR();
  let fecha = String(sp.get('fecha') || hoy).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fecha > hoy) fecha = hoy;
  let c = await leer(tipo, fecha);
  // Hoy: si todavía no está el del día. Otra fecha: si no hay ninguno en esa semana, se trae la historia
  // (un fin de semana usa el último hábil, sin volver a pedir).
  if (fecha === hoy ? !c || c.fecha !== hoy : !c) {
    try {
      if (fecha === hoy) await traerHoy(tipo); else await traerHistoria(tipo);
    } catch (e) {
      console.error('[cotizaciones]', e?.message || e);
    }
    c = (await leer(tipo, fecha)) ?? c;
  }
  if (!c) return { disponible: false, tipo, nombre: NOMBRE[tipo] };
  return { disponible: true, tipo, nombre: NOMBRE[tipo], fecha: c.fecha, venta: c.venta, compra: c.compra };
}

module.exports = { obtenerCotizacion, TIPOS };
