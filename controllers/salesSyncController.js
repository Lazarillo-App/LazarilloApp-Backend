// controllers/salesSyncController.js
const { fetchSalesRanged } = require('../services/maxiSalesService');
const { upsertSalesBatch, setLastSalesSyncAt, getLastSalesSyncAt } = require('../services/salesStore');
const fetch = require('node-fetch');
const pool = require('../config/db');
const { getBearer, STATS_BASE } = require('../services/maxiSalesService');

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

// NUEVO: quick ping para diagnosticar login Maxi desde backend
async function maxiPing  (req, res) {
  try {
    const bizId = req.businessId || req.params.id || req.business?.id;
    if (!bizId) return res.status(400).json({ error: 'invalid_business_id' });

    const bearer = await getBearer(bizId, req);
    // usa una ventana chica cualquiera, no importa la data, solo chequear acceso
    const url = `${STATS_BASE.replace(/\/+$/, '')}/estadisticas/fullinvoicebydate?from=2025-08-01&to=2025-08-07`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch {}
    res.json({
      ok: r.ok && (j?.resultCode === 'SUCCESS' || !j?.resultCode),
      http: r.status,
      resultCode: j?.resultCode,
      used: 'getBearer',
      note: 'Si ok=true, el login/override a Maxi funciona desde el backend.'
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: 'internal', message: e.message });
  }
};

module.exports = { syncSalesForBusiness, maxiPing };
