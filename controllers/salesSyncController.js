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

    const bearer = await getBearer(bizId, req);

    // rango: from/to si vienen, si no AYER (para no pisar política)
    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const AYER = new Date(todayUTC.getTime() - 86400000);

    const from = req.query.from ? new Date(req.query.from) : AYER;
    const to   = req.query.to   ? new Date(req.query.to)   : AYER;

    // Traemos por ventanas de 7 días como en el service
    const payloads = await (async () => {
      const bearerTok = bearer; // ya resuelto
      const a = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
      const b = new Date(Date.UTC(to.getUTCFullYear(),   to.getUTCMonth(),   to.getUTCDate()));
      const windows7 = require('../services/maxiSalesService').buildWindows
        ? require('../services/maxiSalesService').buildWindows(a, b, 7)
        : [[
            `${a.getUTCFullYear()}-${String(a.getUTCMonth()+1).padStart(2,'0')}-${String(a.getUTCDate()).padStart(2,'0')}`,
            `${b.getUTCFullYear()}-${String(b.getUTCMonth()+1).padStart(2,'0')}-${String(b.getUTCDate()).padStart(2,'0')}`
          ]];

      const out = [];
      for (const [fa, fb] of windows7) {
        try {
          const p = await require('../services/maxiSalesService').fetchFullByDate(fa, fb, bearerTok);
          out.push({ window: [fa, fb], keys: Object.keys(p || {}), facturas_len:
            Array.isArray(p?.facturas) ? p.facturas.length :
            Array.isArray(p?.content?.facturas) ? p.content.facturas.length :
            Array.isArray(p?.content) ? p.content.length : 0
          });
        } catch (e) {
          out.push({ window: [fa, fb], error: e?.status || 500, preview: e?._maxi?.bodyPreview });
        }
      }
      return out;
    })();

    // Además, usamos el extractor real para contar “facturas” totales
    const { fetchSalesRanged } = require('../services/maxiSalesService');
    const facturas = await fetchSalesRanged({ businessId: bizId, from, to, req });

    return res.json({
      ok: true,
      business_id: bizId,
      token_ok: Boolean(bearer),
      range: { from: from.toISOString().slice(0,10), to: to.toISOString().slice(0,10) },
      sample_count: Array.isArray(facturas) ? facturas.length : 0,
      windows: payloads    // 👈 debug por ventana (keys y tamaños)
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
