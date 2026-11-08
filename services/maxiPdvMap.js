// services/maxiPdvMap.js
//
// pdv (columna de texto en i25/i80/i12/m0) → en qué schema vive, qué negocio
// de Lazarillo es y a qué sucursal (app_branches) van sus datos. Separado de
// maxiPipelinePurchasesSync.js para que precioCosteoInsumos.js pueda usarlo
// sin crear un import circular
// (maxiPipelinePurchasesSync → purchasesStore → precioCosteoInsumos).
//
// branchId null = negocio principal (convención del front: sin branch_id).
// Un negocio puede tener varios pdv: FCSANJUSTO es la sucursal San Justo
// (app_branches.id 15) del 204, y tiene su propia PC de MaxiRest — por eso
// sus órdenes de pago (i80) chocan con las de FCRAMOS y todo lo que escriben
// los pipelines lleva pdv/branch_id para no pisarse entre sucursales.
// El catálogo (m0/m6) es por schema, compartido entre los pdv.
//
// 214 (subnegocio de 210) todavía no está mapeado: no aparece ningún pdv
// propio en el schema `comercio` aparte de COMERCIO.
//
// Negocios NUEVOS (kit vinculado, Diego 08/11/2026: "no entiendo por qué no se actualizan
// los datos de Palermo suites en Lazarillo"): cada PC vinculada (kit_pcs) dice su esquema,
// pdv, negocio y sucursal — refrescarPdvMap() los suma acá solos, sin tocar este archivo.
// Los de arriba (fijos) mandan: un pdv del kit que choque con uno fijo se ignora.
'use strict';

const PDV_MAP = {
  BAR: { schema: 'container', businessId: 147, branchId: null },
  FCRAMOS: { schema: 'container', businessId: 204, branchId: null },
  FCSANJUSTO: { schema: 'container', businessId: 204, branchId: 15 },
  COMERCIO: { schema: 'comercio', businessId: 210, branchId: null },
};

const FIJOS = new Set(Object.keys(PDV_MAP));
const RE_ESQUEMA = /^[a-z_][a-z0-9_]*$/;
let ultimoRefresco = 0;

// Suma (o saca) los pdv de las PC vinculadas. La última vinculación de cada esquema+pdv manda;
// una PC desvinculada sigue mapeada (sus datos ya subidos siguen siendo de ese negocio).
// Nunca tira: sin la tabla kit_pcs (o sin base) deja el mapa como está.
async function refrescarPdvMap({ forzar = false, db = null } = {}) {
  if (!forzar && Date.now() - ultimoRefresco < 60_000) return PDV_MAP;
  try {
    const base = db || require('../config/db');
    const { rows } = await base.query(
      `SELECT DISTINCT ON (esquema, pdv) esquema, pdv, business_id, branch_id
         FROM kit_pcs ORDER BY esquema, pdv, creado_en DESC, id DESC`);
    const vivos = new Set();
    for (const r of rows) {
      const pdv = String(r.pdv || '');
      if (!pdv || !RE_ESQUEMA.test(String(r.esquema || ''))) continue;
      const nuevo = { schema: r.esquema, businessId: Number(r.business_id), branchId: r.branch_id == null ? null : Number(r.branch_id), origen: 'kit' };
      if (FIJOS.has(pdv)) {
        const f = PDV_MAP[pdv];
        if (f.schema !== nuevo.schema || f.businessId !== nuevo.businessId) {
          console.warn(`[pdv-map] el kit dice ${nuevo.schema}.${pdv} → negocio ${nuevo.businessId}, pero el fijo es ${f.schema} → ${f.businessId}: manda el fijo`);
        }
        continue;
      }
      if (vivos.has(pdv)) { console.warn(`[pdv-map] pdv ${pdv} repetido en dos esquemas: queda el primero`); continue; }
      vivos.add(pdv);
      PDV_MAP[pdv] = nuevo;
    }
    for (const k of Object.keys(PDV_MAP)) if (!FIJOS.has(k) && !vivos.has(k)) delete PDV_MAP[k];
    ultimoRefresco = Date.now();
  } catch (e) {
    if (!/kit_pcs/.test(String(e.message))) console.warn('[pdv-map] no pude leer kit_pcs:', e.message);
  }
  return PDV_MAP;
}

// Al arrancar y cada 10 minutos (los que usan el mapa sin esperar: RRHH, costeo, sync).
if (process.env.PDV_MAP_SIN_REFRESCO !== '1') {
  setTimeout(() => { refrescarPdvMap({ forzar: true }); }, 25_000).unref();
  setInterval(() => { refrescarPdvMap({ forzar: true }); }, 10 * 60_000).unref();
}

// Todos los pdv de un negocio: [{ pdv, schema, branchId }] (vacío si no está mapeado).
function pdvsDeNegocio(businessId) {
  return Object.entries(PDV_MAP)
    .filter(([, v]) => v.businessId === Number(businessId))
    .map(([pdv, v]) => ({ pdv, schema: v.schema, branchId: v.branchId }));
}

// businessId → schema (m0 es un maestro por schema, no por pdv — BAR y
// FCRAMOS comparten el mismo catálogo `container`).
function schemaDeNegocio(businessId) {
  const entry = Object.values(PDV_MAP).find((v) => v.businessId === Number(businessId));
  return entry ? entry.schema : null;
}

// Un branchId hardcodeado acá que no pertenezca al negocio (o que sea la
// principal) mandaría datos a la sucursal equivocada sin que nadie lo note:
// se verifica contra app_branches antes de escribir.
async function verificarSucursales(db, businessId) {
  const conSucursal = pdvsDeNegocio(businessId).filter((p) => p.branchId != null);
  for (const p of conSucursal) {
    const { rows } = await db.query(
      `SELECT business_id, name, COALESCE((props->>'is_main')::boolean, false) AS is_main
         FROM app_branches WHERE id = $1`,
      [p.branchId]
    );
    const b = rows[0];
    if (!b || Number(b.business_id) !== Number(businessId) || b.is_main) {
      throw new Error(
        `PDV_MAP: ${p.pdv} apunta a app_branches.id ${p.branchId}, que no es una sucursal secundaria del negocio ${businessId}`
      );
    }
  }
}

module.exports = { PDV_MAP, PDV_FIJOS: FIJOS, pdvsDeNegocio, schemaDeNegocio, verificarSucursales, refrescarPdvMap };
