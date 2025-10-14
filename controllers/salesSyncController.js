// controllers/salesSyncController.js
const { fetchSalesRanged } = require('../services/maxiSalesService');
const { upsertSalesBatch, setLastSalesSyncAt, getLastSalesSyncAt } = require('../services/salesStore');

async function syncSalesForBusiness(business, { mode = 'auto' } = {}) {
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const oneDay = 86400000;

  const lastTs = await getLastSalesSyncAt(business.id);

  let from, to, chosen = mode;
  if (mode === 'backfill_30d' || !lastTs) {
    to   = new Date(todayUTC.getTime() - oneDay);
    from = new Date(to.getTime() - (30-1)*oneDay);
    chosen = 'backfill_30d';
  } else {
    const last = new Date(lastTs);
    const nextDay = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate()) + oneDay);
    to   = new Date(todayUTC.getTime() - oneDay);
    from = nextDay;
    chosen = 'incremental';
  }
  if (from > to) return { synced:false, mode:chosen, reason:'up-to-date' };

  const sales = await fetchSalesRanged({ businessId: business.id, from, to });
  const { upserted, updated, minDay, maxDay } = await upsertSalesBatch(business.id, sales);

  const toIso = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), 23,59,59)).toISOString();
  await setLastSalesSyncAt(business.id, toIso);

  return {
    synced: true,
    mode: chosen,
    range: { from: from.toISOString().slice(0,10), to: to.toISOString().slice(0,10) },
    counts: { upserted, updated },
    touched: { minDay, maxDay }
  };
}

module.exports = { syncSalesForBusiness };
