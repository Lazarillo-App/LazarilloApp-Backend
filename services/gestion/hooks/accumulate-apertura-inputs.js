// Portado de lazarillo_gestion/hooks/accumulate-apertura-inputs.ts (TypeScript → JavaScript, misma lógica).
'use strict';



/**
 * Junta, a través de todas las tandas de una carpeta, lo que
 * POST /api/etl/drive-import/finalizar necesita para sincronizar apertura
 * una sola vez al final — mismo criterio que antes usaba
 * sincronizarAperturaSiCorresponde en el servidor por request.
 */
function accumulateAperturaInputs(reports) {
  const huboComprasTocadas = reports.some(
    (r) => r.fileType === "compras" && (r.created > 0 || r.updated > 0)
  );
  const comprasModificadas = reports.flatMap((r) => r.comprasDistribuidasModificadas ?? []);
  return { huboComprasTocadas, comprasModificadas };
}

module.exports = { accumulateAperturaInputs };
