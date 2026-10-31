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
'use strict';

const PDV_MAP = {
  BAR: { schema: 'container', businessId: 147, branchId: null },
  FCRAMOS: { schema: 'container', businessId: 204, branchId: null },
  FCSANJUSTO: { schema: 'container', businessId: 204, branchId: 15 },
  COMERCIO: { schema: 'comercio', businessId: 210, branchId: null },
};

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

module.exports = { PDV_MAP, pdvsDeNegocio, schemaDeNegocio, verificarSucursales };
