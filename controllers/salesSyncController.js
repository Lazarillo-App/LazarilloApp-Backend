// controllers/salesSyncController.js
const { fetchSalesRanged, getBearerWithSource, STATS_BASE } = require('../services/maxiSalesService');
const { upsertSalesBatch, setLastSalesSyncAt, getLastSalesSyncAt } = require('../services/salesStore');
const fetch = require('node-fetch');

function ymdUTC(d){
  const pad = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
}
const oneDay = 86400000;

async function syncSalesForBusiness(business, { mode = 'auto', req } = {}) {
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const AYER = new Date(todayUTC.getTime() - oneDay);
  const lastTs = await getLastSalesSyncAt(business.id);

  let from, to, chosen = mode;
  if (mode === 'backfill_30d' || !lastTs) {
    to   = AYER;
    from = new Date(to.getTime() - (30-1)*oneDay);
    chosen = 'backfill_30d';
  } else {
    const last = new Date(lastTs);
    const nextDay = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate()) + oneDay);
    to   = AYER;
    from = nextDay;
    chosen = 'incremental';
  }
  if (from > to) return { synced:false, mode:chosen, range: { from: ymdUTC(from), to: ymdUTC(to) }, counts:{ upserted:0, updated:0 }, touched:{ minDay:null, maxDay:null } };

  // dryrun?
  const dryrun = String(req?.query?.dryrun || '0') === '1';

  const raw = await fetchSalesRanged({ businessId: business.id, from, to, req });
  const rawCount = Array.isArray(raw) ? raw.length : 0;

  if (dryrun) {
    // No tocamos DB ni last_sync
    return {
      synced: false,
      dryrun: true,
      mode: chosen,
      range: { from: ymdUTC(from), to: ymdUTC(to) },
      rawCount
    };
  }

  const { upserted, updated, minDay, maxDay } = await upsertSalesBatch(business.id, raw);

  // Solo marcamos last_sync si hubo inserciones/updates
  if ((upserted || 0) + (updated || 0) > 0) {
    const toIso = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), 23,59,59)).toISOString();
    await setLastSalesSyncAt(business.id, toIso);
  }

  return {
    synced: true,
    mode: chosen,
    range: { from: ymdUTC(from), to: ymdUTC(to) },
    counts: { upserted, updated, raw: rawCount },
    touched: { minDay, maxDay }
  };
}
exports.syncSalesForBusiness = syncSalesForBusiness;

// Diagnóstico: prueba login + rango opcional
exports.maxiPing = async (req, res) => {
  try {
    const bizId = Number(req.params.id || req.businessId);
    if (!Number.isFinite(bizId)) return res.status(400).json({ error: 'invalid_business_id' });

    const { bearer, source } = await getBearerWithSource(bizId, req);

    // Rango opcional
    const from = req.query.from || '2025-08-01';
    const to   = req.query.to   || '2025-08-07';
    const url  = `${STATS_BASE.replace(/\/+$/, '')}/estadisticas/fullinvoicebydate?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const r    = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    const txt  = await r.text().catch(()=> ''); let j; try { j = JSON.parse(txt); } catch {}

    res.json({
      ok: r.ok && (j?.resultCode === 'SUCCESS' || !j?.resultCode),
      http: r.status,
      resultCode: j?.resultCode || null,
      resultDescription: j?.resultDescription || null,
      used: source,
      from, to,
      bytes: Buffer.byteLength(txt || '', 'utf8'),
      preview: j?.content ? (j.content.cantidad ?? null) : null
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: 'internal', message: e.message });
  }
};
