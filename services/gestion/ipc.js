// IPC mensual (Diego 23/11/2026): para ver el mismo mes de años distintos en «pesos de hoy».
// Fuente pública y gratuita, sin conector: ArgentinaDatos (variación % mensual del INDEC). Se guarda en
// gestion_ipc y vale para todos los negocios. Si la fuente no responde, se usa lo guardado; si no hay
// nada, el ajuste no está disponible y la pantalla lo dice (nunca inventa un número).
// Solo se ajustan importes: tickets y cubiertos son unidades.
'use strict';

const { sql, db } = require('./db');

const URL_IPC = 'https://api.argentinadatos.com/v1/finanzas/indices/inflacion';
const TIMEOUT = 6000;
const REINTENTO_MS = 6 * 3_600_000; // si falló o no hay mes nuevo, no se vuelve a pedir por 6 h
let ultimoIntento = 0;

const mesDe = (d) => String(d ?? '').slice(0, 7); // 'YYYY-MM'

async function traer() {
  const r = await fetch(URL_IPC, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`${URL_IPC} → ${r.status}`);
  const d = await r.json();
  if (!Array.isArray(d)) return;
  const ok = d.map((x) => ({ mes: mesDe(x.fecha), v: Number(x.valor) }))
    .filter((x) => /^\d{4}-\d{2}$/.test(x.mes) && Number.isFinite(x.v));
  if (!ok.length) return;
  await db.execute(sql`
    INSERT INTO gestion_ipc (mes, variacion, fuente)
    SELECT (m || '-01')::date, v, 'argentinadatos' FROM unnest(${ok.map((x) => x.mes)}::text[], ${ok.map((x) => x.v)}::numeric[]) AS t(m, v)
    ON CONFLICT (mes) DO UPDATE SET variacion = EXCLUDED.variacion, fuente = EXCLUDED.fuente`);
}

const leer = () => db.many(sql`SELECT to_char(mes, 'YYYY-MM') AS mes, variacion::float8 AS v FROM gestion_ipc ORDER BY mes`);

/**
 * Nivel de precios por mes ('YYYY-MM' → índice encadenado) y el último mes publicado.
 * { disponible:false } si no hay datos.
 */
async function nivelesIpc() {
  let filas = await leer();
  // El IPC de un mes sale a mediados del siguiente: se pide de nuevo si lo guardado tiene más de un mes de atraso.
  const hoy = new Date(Date.now() - 3 * 3_600_000);
  const esperado = mesDe(new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1)).toISOString());
  const ultimo = filas.length ? filas[filas.length - 1].mes : null;
  if ((!ultimo || ultimo < esperado) && Date.now() - ultimoIntento > REINTENTO_MS) {
    ultimoIntento = Date.now();
    try { await traer(); filas = await leer(); } catch (e) { console.error('[ipc]', e?.message || e); }
  }
  if (!filas.length) return { disponible: false };
  const nivel = new Map();
  let n = 100;
  for (const f of filas) { n *= 1 + f.v / 100; nivel.set(f.mes, n); }
  return { disponible: true, nivel, desde: filas[0].mes, hasta: filas[filas.length - 1].mes };
}

module.exports = { nivelesIpc };
