// services/recetasDesdeKit.js
// Recetas al día con lo que sube el kit (Diego, 06/11/2026). Corre los pipelines de Mairene
// que leen del kit — ventas del 12 (syncVentasDeNegocio → sales_daily_items) y compras/pagos
// del 25 y el 80 (syncComprasDeNegocio → purchases, con cascada a los costos) — sin tocarlos.
//
// Dos entradas:
//  - el pulso del header (POST /api/businesses/:id/pulso/actualizar): un negocio, a pedido;
//  - el reloj de cada hora (minuto 20, después de la ingesta de Balance del minuto 5): solo
//    los negocios cuyo kit subió algo del 12/25/80 DESPUÉS de la última pasada a Recetas
//    (_cargas del esquema vs. la última escritura 'maxi' en sales_daily_items / purchases).
//    Sin novedades no hace nada; cada pasada relee 2 años y tarda ~3 min por negocio.
//
// Candado: en memoria (un proceso) + pg_try_advisory_lock(7310000 + negocio), así el pulso,
// el reloj y otro servicio con la misma base no corren el mismo negocio a la vez.
'use strict';

const pool = require('../config/db');
const { PDV_MAP, refrescarPdvMap } = require('./maxiPdvMap');
const { syncVentasDeNegocio } = require('./maxiPipelineSalesSync');
const { syncComprasDeNegocio } = require('./maxiPipelinePurchasesSync');

const CANDADO_RECETAS = 7_310_000; // + businessId
const enCurso = new Set();

// Para el log: sin listas largas.
function resumir(r) {
  if (!r || typeof r !== 'object') return r;
  return JSON.parse(JSON.stringify(r, (k, v) => (Array.isArray(v) && v.length > 5 ? `[${v.length}]` : v)));
}

async function correrRecetas(businessId, origen = 'pulso') {
  const client = await pool.connect();
  let tomado = false;
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [CANDADO_RECETAS + businessId]);
    tomado = !!rows[0]?.ok;
    if (!tomado) { console.log(`[recetas-kit] ${origen} ${businessId}: ya corriendo en otro lado, se saltea`); return { saltado: true }; }
    const t0 = Date.now();
    await refrescarPdvMap(); // negocios nuevos del kit vinculado (kit_pcs)
    const ventas = await syncVentasDeNegocio(businessId);
    const compras = await syncComprasDeNegocio(businessId);
    console.log(`[recetas-kit] ${origen} ${businessId} ${Date.now() - t0}ms`,
      JSON.stringify({ ventas: resumir(ventas), compras: resumir(compras) }).slice(0, 600));
    return { ventas, compras };
  } finally {
    if (tomado) await client.query('SELECT pg_advisory_unlock($1)', [CANDADO_RECETAS + businessId]).catch(() => {});
    client.release();
  }
}

// Dispara en segundo plano si no está corriendo. Devuelve 'iniciado' | 'en_curso'.
function dispararRecetas(businessId, origen = 'pulso') {
  if (enCurso.has(businessId)) return 'en_curso';
  enCurso.add(businessId);
  setImmediate(async () => {
    try {
      await correrRecetas(businessId, origen);
    } catch (e) {
      console.error(`[recetas-kit] ${origen} ${businessId}:`, e?.message || e);
    } finally {
      enCurso.delete(businessId);
    }
  });
  return 'iniciado';
}

const recetasEnCurso = (businessId) => enCurso.has(Number(businessId));

// negocio → { schema: [pdv, …] } a partir de PDV_MAP (whitelist: el esquema nunca viene de afuera).
function destinosPorNegocio() {
  const m = new Map();
  for (const [pdv, v] of Object.entries(PDV_MAP)) {
    if (!m.has(v.businessId)) m.set(v.businessId, {});
    const porEsq = m.get(v.businessId);
    (porEsq[v.schema] ||= []).push(pdv);
  }
  return m;
}

// ¿El kit subió 12/25/80 de este negocio después de la última pasada a Recetas?
async function hayNovedades(businessId, porEsquema) {
  let ultimaCarga = null;
  for (const [schema, pdvs] of Object.entries(porEsquema)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) continue;
    const { rows } = await pool.query(
      `SELECT MAX(cargado) AS c FROM "${schema}"._cargas
        WHERE pdv = ANY($1::text[])
          AND (tabla LIKE 'i12\\_%' OR tabla LIKE 'i25\\_%' OR tabla LIKE 'i80\\_%')`,
      [pdvs]
    );
    const c = rows[0]?.c ? new Date(rows[0].c) : null;
    if (c && (!ultimaCarga || c > ultimaCarga)) ultimaCarga = c;
  }
  if (!ultimaCarga) return false;
  const { rows } = await pool.query(
    `SELECT GREATEST(
       (SELECT MAX(updated_at) FROM sales_daily_items WHERE business_id = $1 AND source = 'maxi'),
       (SELECT MAX(synced_at) FROM purchases WHERE business_id = $1 AND source = 'maxi')
     ) AS u`,
    [businessId]
  );
  const ultimaPasada = rows[0]?.u ? new Date(rows[0].u) : null;
  return !ultimaPasada || ultimaCarga > ultimaPasada;
}

// La pasada del reloj: de a un negocio (no cargar la base de golpe).
async function recetasDelReloj() {
  await refrescarPdvMap({ forzar: true });
  for (const [businessId, porEsquema] of destinosPorNegocio()) {
    try {
      if (enCurso.has(businessId)) continue;
      if (!(await hayNovedades(businessId, porEsquema))) continue;
      enCurso.add(businessId);
      try { await correrRecetas(businessId, 'reloj'); } finally { enCurso.delete(businessId); }
    } catch (e) {
      console.error(`[recetas-kit] reloj ${businessId}:`, e?.message || e);
    }
  }
}

module.exports = { correrRecetas, dispararRecetas, recetasEnCurso, recetasDelReloj, hayNovedades };
