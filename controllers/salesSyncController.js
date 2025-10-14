// controllers/salesSyncController.js
const { fetchSalesRanged } = require('../services/maxiSalesService');
const { upsertSalesBatch, setLastSalesSyncAt, getLastSalesSyncAt } = require('../services/salesStore');
const fetch = require('node-fetch');
const { getBearer, STATS_BASE } = require('../services/maxiSalesService');

function parseDate(d) {
  if (!d) return null;
  const [y,m,day] = String(d).split('-').map(Number);
  if (!y || !m || !day) return null;
  return new Date(Date.UTC(y, m-1, day));
}

async function syncSalesForBusiness(business, { mode='auto', dryrun=false, from, to, req } = {}) {
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const oneDay = 86400000;

  // rango manual si viene en query
  let fromDt = parseDate(from);
  let toDt   = parseDate(to);

  if (!fromDt || !toDt) {
    // lógica anterior
    const lastTs = await getLastSalesSyncAt(business.id);
    if (mode === 'backfill_30d' || !lastTs) {
      toDt   = new Date(todayUTC.getTime() - oneDay);
      fromDt = new Date(toDt.getTime() - (30-1)*oneDay);
      mode   = 'backfill_30d';
    } else {
      const last = new Date(lastTs);
      const nextDay = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate()) + oneDay);
      toDt   = new Date(todayUTC.getTime() - oneDay);
      fromDt = nextDay;
      mode   = 'incremental';
    }
  }

  if (fromDt > toDt) {
    return { synced:false, mode, reason:'up-to-date', range:{ from:null, to:null } };
  }

  // trae ventas (usa req para permitir X-Maxi-Token si lo mandás)
  const sales = await fetchSalesRanged({ businessId: business.id, from: fromDt, to: toDt, req });

  if (dryrun) {
    return {
      synced: false,
      dryrun: true,
      mode,
      range: { from: fromDt.toISOString().slice(0,10), to: toDt.toISOString().slice(0,10) },
      rawCount: Array.isArray(sales) ? sales.length : 0
    };
  }

  const { upserted, updated, minDay, maxDay } = await upsertSalesBatch(business.id, sales);

  const toIso = new Date(Date.UTC(toDt.getUTCFullYear(), toDt.getUTCMonth(), toDt.getUTCDate(), 23,59,59)).toISOString();
  await setLastSalesSyncAt(business.id, toIso);

  return {
    synced: true,
    mode,
    range: { from: fromDt.toISOString().slice(0,10), to: toDt.toISOString().slice(0,10) },
    counts: { upserted, updated },
    touched: { minDay, maxDay }
  };
}

// Quick ping (acepta ?from&to)
async function maxiPing(req, res) {
  try {
    const bizId = req.businessId || req.params.id || req.business?.id;
    if (!bizId) return res.status(400).json({ error: 'invalid_business_id' });

    const bearer = await getBearer(bizId, req);
    const from = req.query.from || '2025-08-01';
    const to   = req.query.to   || '2025-08-07';
    const url  = `${STATS_BASE.replace(/\/+$/, '')}/estadisticas/fullinvoicebydate?from=${from}&to=${to}`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch {}
    res.json({
      ok: r.ok && (j?.resultCode === 'SUCCESS' || !j?.resultCode),
      http: r.status,
      resultCode: j?.resultCode || null,
      resultDescription: j?.resultDescription || null,
      used: 'getBearer',
      preview: j?.content?.facturas ? j.content.facturas.slice(0, 1) : null,
      from, to
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: 'internal', message: e.message });
  }
}

module.exports = { syncSalesForBusiness, maxiPing };
