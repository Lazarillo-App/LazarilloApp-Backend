// services/businessOnboarding.js

const { importMaxiMenuForBusiness } = require('./maxiMenuService');

// ✅ AHORA: usamos el orquestador V2 de ventas
const { syncSalesForBusiness } = require('../controllers/salesSyncController');

// ✅ Store de negocios (el que ya creaste)
const { getBusinessById } = require('./businessesStore');

async function onboardBusiness(businessId, { daysBack = 7 } = {}) {
  const biz = await getBusinessById(businessId);
  if (!biz) {
    throw new Error(`Negocio ${businessId} no existe`);
  }

  // 1) Importar catálogo Maxi (maxi_articles + maxi_article_map)
  await importMaxiMenuForBusiness(businessId);

  // 2) Rango de fechas a sincronizar (últimos N días)
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - daysBack);

  const fromYmd = from.toISOString().slice(0, 10);
  const toYmd   = to.toISOString().slice(0, 10);

  // 3) Sincronizar ventas usando el motor V2
  //    👇 usamos el mismo helper que el endpoint /:id/sync-sales
  const res = await syncSalesForBusiness(
    biz,
    {
      mode: 'window', // sincroniza un rango específico
      from: fromYmd,
      to: toYmd,
    },
    null // req: null porque estamos del lado servidor sin request HTTP
  );

  // Por si res no trae estos campos, no pasa nada grave;
  // lo importante es el side-effect (ventas grabadas en DB)
  return {
    ok: true,
    business_id: businessId,
    from: res?.minDay ?? fromYmd,
    to: res?.maxDay ?? toYmd,
    upserted: res?.upserted ?? null,
    updated: res?.updated ?? null,
  };
}

module.exports = { onboardBusiness };
