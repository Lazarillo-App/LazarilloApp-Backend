// services/maxiPdvMap.js
//
// pdv (columna de texto en i25/i80/i12/m0) → en qué schema vive y qué negocio
// de Lazarillo es. Separado de maxiPipelinePurchasesSync.js para que
// precioCosteoInsumos.js pueda usarlo sin crear un import circular
// (maxiPipelinePurchasesSync → purchasesStore → precioCosteoInsumos).
//
// San Justo (FCSANJUSTO) todavía no sube datos — se agrega acá en cuanto el
// colega confirme que esa PC está sincronizando. 214 (subnegocio de 210)
// tampoco está mapeado todavía: no aparece ningún pdv propio en el schema
// `comercio` aparte de COMERCIO (confirmado con listar-pdv-de-schema.js).
'use strict';

const PDV_MAP = {
  BAR: { schema: 'container', businessId: 147 },
  FCRAMOS: { schema: 'container', businessId: 204 },
  COMERCIO: { schema: 'comercio', businessId: 210 },
};

// businessId → schema (m0 es un maestro por schema, no por pdv — BAR y
// FCRAMOS comparten el mismo catálogo `container`).
function schemaDeNegocio(businessId) {
  const entry = Object.values(PDV_MAP).find((v) => v.businessId === Number(businessId));
  return entry ? entry.schema : null;
}

module.exports = { PDV_MAP, schemaDeNegocio };
