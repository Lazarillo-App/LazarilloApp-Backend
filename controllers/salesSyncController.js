// controllers/salesSyncController.js
const {
  fetchSalesRanged,
  getBearer,
  fetchFullByDate,
} = require('../services/maxiSalesService');
const { upsertSalesBatch } = require('../services/salesStore');
const { ensureInitialBackfillOnce, runDailyAuto } = require('../services/salesSyncPolicy');

// ───────── helpers fecha (UTC @ 00:00) ─────────
function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth(),1)}-${pad2(d.getUTCDate())}`; }
function at00UTC(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function clampToYesterday(dateUTC00) {
  const today = at00UTC(new Date());
  const ayer = new Date(today.getTime() - 86400000);
  return dateUTC00 > ayer ? ayer : dateUTC00;
}
function parseYMD(s) {
  if (!s) return null;
  // Permite YYYY-MM-DD o fechas parseables por Date
  const d = s.length === 10 ? new Date(`${s}T00:00:00Z`) : new Date(s);
  return isNaN(d) ? null : at00UTC(d);
}

// Ventanea [from..to] en bloques inclusivos de N días (p.ej. 7)
function buildWindows(from, to, size = 7) {
  const out = [];
  let a = at00UTC(from);
  const T = at00UTC(to);
  while (a <= T) {
    let b = new Date(a.getTime()(size - 1) * 86400000);
    if (b > T) b = T;
    out.push([a, b]);
    a = new Date(b.getTime(),  86400000); // siguiente día del final
  }
  return out;
}

// ========== Diagnóstico directo contra Maxi ==========
async function maxiPing(req, res, next) {
  try {
    const bizId =
      Number(req.business?.id) ||
      Number(req.params.id) ||
      Number(req.headers['x-business-id']);

    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ error: 'invalid_business_id' });
    }

    // Bearer (acepta X-Maxi-Token override)
    const bearer = await getBearer(bizId, req);

    // Fechas: si no vienen, usar AYER; siempre clamp a AYER
    let from = parseYMD(req.query.from);
    let to = parseYMD(req.query.to);

    const todayUTC = at00UTC(new Date());
    const AYER = new Date(todayUTC.getTime() - 86400000);

    if (!from) from = AYER;
    if (!to) to = AYER;

    from = at00UTC(from);
    to = clampToYesterday(at00UTC(to));

    if (from > to) {
      return res.status(400).json({ error: 'from > to (invalid range)', from: ymd(from), to: ymd(to) });
    }

    // Ventanas de 7 días (igual que el service)
    const windows7 = buildWindows(from, to, 7);
    const out = [];

    for (const [fa, fb] of windows7) {
      try {
        const p = await fetchFullByDate(fa, fb, bearer);
        const len =
          Array.isArray(p?.facturas) ? p.facturas.length :
            Array.isArray(p?.content?.facturas) ? p.content.facturas.length :
              Array.isArray(p?.content?.content) ? p.content.content.length :
                Array.isArray(p?.content) ? p.content.length :
                  Array.isArray(p) ? p.length :
                    0;
        out.push({
          window: [fa, fb],
          ok: true,
          keys: Object.keys(p || {}),
          length_guess: len,
        });
      } catch (e) {
        out.push({
          window: [fa, fb],
          ok: false,
          status: e?.status || 500,
          preview: e?._maxi?.bodyPreview || String(e?.message || '').slice(0, 200),
        });
      }
    }

    // Además: pasamos por el extractor real del service (incluye fallback diario)
    const facturas = await fetchSalesRanged({ businessId: bizId, from, to, req });

    return res.json({
      ok: true,
      business_id: bizId,
      token_ok: Boolean(bearer),
      range: { from: ymd(from), to: ymd(to) },
      sample_count: Array.isArray(facturas) ? facturas.length : 0,
      windows: out,
    });
  } catch (e) {
    return next(e);
  }
}

// ========== Fachada de sync con la policy ==========
async function syncSalesForBusiness(
  business,
  { mode = 'auto', from = null, to = null, dryrun = false, req } = {}
) {
  if (!business || !business.id) {
    throw new TypeError('business.id required');
  }

  // 1) backfill canónico (30d hasta AYER, una vez)
  if (mode === 'backfill' || mode === 'backfill_30d') {
    if (dryrun) {
      const r = await ensureInitialBackfillOnce({ businessId: business.id, req });
      return { ...r, note: 'ensureInitialBackfillOnce executed (policy). Dryrun real no implementado aquí.' };
    }
    return await ensureInitialBackfillOnce({ businessId: business.id, req });
  }

  // 2) auto incremental (desde último día  1 hasta AYER)
  if (!from && !to) {
    return await runDailyAuto({ businessId: business.id, req });
  }

  // 3) rango puntual (clamp y validación)
  if (from && to) {
    let F = parseYMD(from);
    let T = parseYMD(to);
    if (!F || !T) {
      return { ok: false, error: 'invalid_from_or_to (use YYYY-MM-DD)' };
    }
    F = at00UTC(F);
    T = clampToYesterday(at00UTC(T));
    if (F > T) {
      return { ok: false, error: 'from > to (invalid range)', range: { from: ymd(F), to: ymd(T) } };
    }

    // Trae desde Maxi con fallback 7d→1d y normaliza
    const salesRaw = await fetchSalesRanged({ businessId: business.id, from: F, to: T, req });

    if (dryrun) {
      return {
        ok: true,
        dryrun: true,
        rawCount: Array.isArray(salesRaw) ? salesRaw.length : 0,
        range: { from: ymd(F), to: ymd(T) },
      };
    }

    // Persiste en lote (idempotente por external_id / line_pos)
    const counts = await upsertSalesBatch(business.id, salesRaw);
    return { ok: true, mode: 'range', range: { from: ymd(F), to: ymd(T) }, ...counts };
  }

  return { ok: false, error: 'invalid_range_or_mode' };
}

module.exports = { maxiPing, syncSalesForBusiness };
