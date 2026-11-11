// services/kit/despuesDeSubir.js
// Lazarillo lee lo que sube el kit apenas termina de subir (Diego, 11/11/2026: "si la información
// está subida, el resto es problema nuestro… tenemos que trabajar en que no suceda"). Antes la
// lectura esperaba al reloj de cada hora (Balance minuto 5, Recetas minuto 20), y el pulso
// mostraba un aviso mientras tanto.
//
// Cada POST /api/kit/cargas avisa acá. Como una PC sube tabla por tabla, se espera a que pase un
// rato sin cargas nuevas de ese negocio (TRANQUILO_MS) y recién ahí:
//   - Balance: la ingesta del kit (la misma del reloj; candado compartido, lee solo lo que cambió);
//   - maestros (artículos/insumos) si la PC subió maestros, antes que Recetas (como el reloj);
//   - Recetas: si subió algo del 12/25/80, ventas y compras desde el kit (recetasDesdeKit).
// Si Recetas falla, reintenta una vez más tarde (REINTENTO_MS); si vuelve a fallar queda en el log
// ("[kit-leer]") y lo levanta el reloj de cada hora. Las PC que suben directo a la base (sin
// vincular) siguen con el reloj.
'use strict';

const TRANQUILO_MS = Number(process.env.KIT_LEER_TRANQUILO_MS) || 4 * 60_000;
const REINTENTO_MS = 15 * 60_000;
const RE_RECETAS = /^i(12|25|80)_/;

const pendientes = new Map(); // businessId → { timer, recetas }

async function leerBalance(businessId) {
  const { abrirCorrida, ejecutarCorrida } = require('../gestion/render/sync');
  const id = await abrirCorrida('kit');
  if (id == null) { console.log(`[kit-leer] ${businessId} balance: ya hay una lectura en curso`); return; }
  await ejecutarCorrida(id, 'kit');
}

async function leerRecetas(businessId, intento = 1) {
  const { correrRecetas } = require('../recetasDesdeKit');
  try {
    const r = await correrRecetas(businessId, 'kit');
    if (r?.errores?.length) throw new Error(r.errores.join(' · '));
  } catch (e) {
    console.error(`[kit-leer] ${businessId} recetas (intento ${intento}):`, e?.message || e);
    if (intento < 2) setTimeout(() => { leerRecetas(businessId, intento + 1).catch(() => {}); }, REINTENTO_MS).unref?.();
  }
}

async function leer(businessId, { recetas, maestros }) {
  try { require('./frescuraKit').olvidarFrescura(businessId); } catch { /* no importa */ }
  try { await leerBalance(businessId); } catch (e) { console.error(`[kit-leer] ${businessId} balance:`, e?.message || e); }
  if (maestros) {
    try { await require('./maestrosDesdeKit').maestrosDelReloj(); } catch (e) { console.error(`[kit-leer] ${businessId} maestros:`, e?.message || e); }
  }
  if (recetas) await leerRecetas(businessId);
}

// pc = fila de kit_pcs; tabla = la que acaba de subir.
function avisarCarga(pc, tabla) {
  const businessId = Number(pc?.business_id);
  if (!businessId) return;
  const p = pendientes.get(businessId) || { timer: null, recetas: false, maestros: false };
  if (RE_RECETAS.test(String(tabla || ''))) p.recetas = true;
  if (/^m/.test(String(tabla || ''))) p.maestros = true;
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    const { recetas, maestros } = p;
    pendientes.delete(businessId);
    leer(businessId, { recetas, maestros }).catch((e) => console.error(`[kit-leer] ${businessId}:`, e?.message || e));
  }, TRANQUILO_MS);
  pendientes.set(businessId, p);
}

module.exports = { avisarCarga };
