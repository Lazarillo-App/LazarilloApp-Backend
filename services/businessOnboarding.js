// services/businessOnboarding.js
const { importMaxiMenuForBusiness } = require('./maxiMenuService');
const { syncSalesWindow } = require('./maxiSalesService');
const { getBusinessById } = require('./businessesStore');

async function onboardBusiness(businessId, { daysBack = 7 } = {}) {
  const biz = await getBusinessById(businessId);
  if (!biz) {
    throw new Error(`Negocio ${businessId} no existe`);
  }

  // 1) Verificar que tenga credenciales Maxi
  // (podés llamar internamente a maxi-ping o reusar tu helper)
  // Si falla, tirás error claro tipo "Faltan credenciales Maxi".

  // 2) Importar catálogo Maxi (maxi_articles + maxi_article_map)
  await importMaxiMenuForBusiness(businessId);

  // 3) Rango de fechas a sincronizar (últimos N días)
  const to = new Date(); // hoy
  const from = new Date();
  from.setDate(to.getDate() - daysBack);

  const fromYmd = from.toISOString().slice(0, 10);
  const toYmd   = to.toISOString().slice(0, 10);

  // 4) Sincronizar ventas de ese rango
  const res = await syncSalesWindow(businessId, { from: fromYmd, to: toYmd });

  return {
    ok: true,
    business_id: businessId,
    from: res.minDay,
    to: res.maxDay,
    upserted: res.upserted,
    updated: res.updated,
  };
}

module.exports = { onboardBusiness };
