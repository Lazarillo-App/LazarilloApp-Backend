// controllers/salesSyncController.js
const { fetchSalesRanged } = require('../services/maxiSalesService');
const { upsertSalesBatch, setLastSalesSyncAt, getLastSalesSyncAt } = require('../services/salesStore');
const { getBearer } = require('../services/maxiSalesService');

// === NUEVO: handler simple para diagnosticar credenciales/alcance ===
async function maxiPing(req, res, next) {
  try {
    const bizId =
      Number(req.business?.id) ||
      Number(req.params.id) ||
      Number(req.headers['x-business-id']);

    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ error: 'invalid_business_id' });
    }

    // Verifica que podamos obtener token
    const bearer = await getBearer(bizId, req);

    // Si vienen ?from&to probamos una llamada real; si no, probamos una ventana corta (ayer)
    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const AYER = new Date(todayUTC.getTime() - 86400000);

    const from = req.query.from ? new Date(req.query.from) : AYER;
    const to   = req.query.to   ? new Date(req.query.to)   : AYER;

    // Llamamos a Maxi a través de nuestro servicio (no escribe en DB)
    const facturas = await fetchSalesRanged({ businessId: bizId, from, to, req });

    return res.json({
      ok: true,
      business_id: bizId,
      token_ok: Boolean(bearer),
      range: {
        from: from.toISOString().slice(0,10),
        to:   to.toISOString().slice(0,10),
      },
      sample_count: Array.isArray(facturas) ? facturas.length : 0,
    });
  } catch (e) {
    return next(e);
  }
}

async function syncSalesForBusiness(business, { mode = 'auto', from = null, to = null, dryrun = false, req } = {}) {
  if (!business || !business.id) {
    throw new TypeError('business.id required');
  }

  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const oneDay = 86400000;

  let rangeFrom = from ? new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) : null;
  let rangeTo   = to   ? new Date(Date.UTC(to.getUTCFullYear(),   to.getUTCMonth(),   to.getUTCDate()))   : null;

  if (!rangeFrom || !rangeTo) {
    const lastTs = await getLastSalesSyncAt(business.id);
    let chosen = mode;

    if (mode === 'backfill_30d' || !lastTs) {
      rangeTo   = new Date(todayUTC.getTime() - oneDay);
      rangeFrom = new Date(rangeTo.getTime() - (30 - 1) * oneDay);
      chosen = 'backfill_30d';
    } else {
      const last = new Date(lastTs);
      const nextDay = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate()) + oneDay);
      rangeTo   = new Date(todayUTC.getTime() - oneDay);
      rangeFrom = nextDay;
      chosen = 'incremental';
    }
    mode = chosen;
  }

  if (rangeFrom > rangeTo) {
    return { synced: false, dryrun, mode, reason: 'up-to-date', range: { from: rangeFrom.toISOString().slice(0,10), to: rangeTo.toISOString().slice(0,10) } };
  }

  const sales = await fetchSalesRanged({
    businessId: business.id,
    from: rangeFrom,
    to: rangeTo,
    req,
    preview: dryrun
  });

  if (dryrun) {
    return {
      synced: false,
      dryrun: true,
      mode,
      range: { from: rangeFrom.toISOString().slice(0,10), to: rangeTo.toISOString().slice(0,10) },
      rawCount: Array.isArray(sales) ? sales.length : (sales?.length ?? 0)
    };
  }

  const { upserted, updated, minDay, maxDay } = await upsertSalesBatch(business.id, sales);

  const toIso = new Date(Date.UTC(rangeTo.getUTCFullYear(), rangeTo.getUTCMonth(), rangeTo.getUTCDate(), 23,59,59)).toISOString();
  await setLastSalesSyncAt(business.id, toIso);

  return {
    synced: true,
    mode,
    range: { from: rangeFrom.toISOString().slice(0,10), to: rangeTo.toISOString().slice(0,10) },
    counts: { upserted, updated, raw: Array.isArray(sales) ? sales.length : (sales?.length ?? 0) },
    touched: { minDay, maxDay }
  };
}

module.exports = { maxiPing, syncSalesForBusiness };
