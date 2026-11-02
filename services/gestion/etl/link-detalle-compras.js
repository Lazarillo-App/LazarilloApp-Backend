// Portado de lazarillo_gestion/lib/etl/link-detalle-compras.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { linkDetalleComprasByComprobante } = require('./normalizer-utils');

async function linkDetalleCompras(db, ctx) {
  if (ctx?.businessId == null) return;
  await linkDetalleComprasByComprobante(db, ctx);
}

module.exports = { linkDetalleCompras };
