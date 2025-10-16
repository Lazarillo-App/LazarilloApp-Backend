// controllers/salesSyncController.js
const { fetchSalesRanged, getBearer, fetchFullByDate, buildWindows } = require('../services/maxiSalesService');
const { upsertSalesBatch } = require('../services/salesStore');
const { ensureInitialBackfillOnce, runDailyAuto } = require('../services/salesSyncPolicy');

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
    const to = req.query.to ? new Date(req.query.to) : AYER;

    // Traemos por ventanas de 7 días como en el service (diagnóstico)

    const bearerTok = bearer;
    const a = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    const b = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
    const windows7 = typeof buildWindows === 'function'
      ? buildWindows(a, b, 7)
      : [[
        `${a.getUTCFullYear()}-${String(a.getUTCMonth(),1).padStart(2, '0')}-${String(a.getUTCDate()).padStart(2, '0')}`,
        `${b.getUTCFullYear()}-${String(b.getUTCMonth(),1).padStart(2, '0')}-${String(b.getUTCDate()).padStart(2, '0')}`
      ]];

    const out = [];
    for (const [fa, fb] of windows7) {
      try {
        const p = await fetchFullByDate(fa, fb, bearerTok);
        out.push({
          window: [fa, fb], keys: Object.keys(p || {}), facturas_len:
            Array.isArray(p?.facturas) ? p.facturas.length :
              Array.isArray(p?.content?.facturas) ? p.content.facturas.length :
                Array.isArray(p?.content) ? p.content.length : 0
        });
      } catch (e) {
        out.push({ window: [fa, fb], error: e?.status || 500, preview: e?._maxi?.bodyPreview });
      }
    }
    // Además, usamos el extractor real para contar “facturas” totales
    const facturas = await fetchSalesRanged({ businessId: bizId, from, to, req });

    return res.json({
      ok: true,
      business_id: bizId,
      token_ok: Boolean(bearer),
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      sample_count: Array.isArray(facturas) ? facturas.length : 0,
      windows: out    // 👈 debug por ventana (keys y tamaños)
    });
  } catch (e) {
    return next(e);
  }
}

// === NUEVO: fachada del controller que usa la policy ===
async function syncSalesForBusiness(business, { mode = 'auto', from = null, to = null, dryrun = false, req } = {}) {
  if (!business || !business.id) {
    throw new TypeError('business.id required');
  }
  // 1) modos canónicos
  if (mode === 'backfill' || mode === 'backfill_30d') {
    if (dryrun) {
      // previsualización: solo contaríamos sin persistir
      const r = await ensureInitialBackfillOnce({ businessId: business.id, req });
      // ensureInitialBackfillOnce ya persiste; si querés dryrun real, comenta la línea anterior
      return { ...r, note: 'ensureInitialBackfillOnce executed (policy). Dryrun real no implementado aquí.' };
    }
    return await ensureInitialBackfillOnce({ businessId: business.id, req });
  }
  if (!from && !to) {
    // 2) auto incremental
    return await runDailyAuto({ businessId: business.id, req });
  }
  // 3) rango puntual (soporte opcional)
  if (from && to) {
    const sales = await fetchSalesRanged({ businessId: business.id, from, to, req });
    if (dryrun) {
      return { ok: true, dryrun: true, rawCount: Array.isArray(sales) ? sales.length : 0, range: { from, to } };
    }
    const r = await upsertSalesBatch(business.id, sales);
    return { ok: true, mode: 'range', range: { from, to }, ...r };
  }
  return { ok: false, error: 'invalid_range_or_mode' };
}

module.exports = { maxiPing, syncSalesForBusiness };
