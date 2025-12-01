// controllers/businessController.js
const path = require('path');
const pool = require('../config/db');
const { decryptSecretCompat, encryptSecret } = require('../utils/cryptoField');
const { rebuildArticleMapFromAppArticles } = require('../services/maxiArticleMapService');

// fetch compatible en Node 18+ (usa global)
const fetch = (...args) => globalThis.fetch(...args);

// Sync ventas (servicios)
const { ensureInitialBackfillOnce, runDailyAuto } = require('../services/salesSyncPolicy');
const { fetchSalesRanged, getBearer, fetchInvoiceByDate, extractFacturas } = require('../services/maxiSalesService');
const { upsertSalesBatch } = require('../services/salesStore');

// Artículos
const { fetchArticlesTree } = require('../services/articlesRepo');

const MAXI_BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ───────────────── helpers ───────────────── */
const slugify = (s = '') => {
  const out = String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 40);
  return out || 'local';
};

function attachBranding(biz) {
  const br = (biz?.props && biz.props.branding) || biz.branding || {};
  return { ...biz, branding: { ...(biz.branding || {}), ...br } };
}

// Fechas (UTC día)
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const at00 = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDaysUTC = (d, n) => new Date(d.getTime() + n * 86400000);

function clampToYesterday(fromStr, toStr) {
  const today = at00(new Date());
  const AYER = addDaysUTC(today, -1);
  const F = fromStr ? at00(new Date(fromStr)) : AYER;
  const T = toStr ? at00(new Date(toStr)) : AYER;
  const Tc = T > AYER ? AYER : T;
  if (isNaN(+F) || isNaN(+Tc)) throw Object.assign(new Error('invalid_date'), { status: 400 });
  if (F > Tc) throw Object.assign(new Error('from_after_to'), { status: 400 });
  return { from: ymd(F), to: ymd(Tc) };
}

/* ───────────────── Negocios (CRUD + selección) ───────────────── */
exports.listMine = async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    const { rows } = await pool.query(`
      SELECT DISTINCT b.id, b.name, b.slug, b.props, b.owner_id, b.created_at
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id = b.id
      WHERE (ub.user_id = $1 OR b.owner_id = $1)
      ORDER BY b.created_at ASC;
    `, [uid]);

    res.json({ items: rows.map(attachBranding) });
  } catch (e) {
    console.error('GET /api/businesses error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.getActive = async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });
    const { rows } = await pool.query(
      `SELECT active_business_id FROM app_users WHERE id = $1`,
      [uid]
    );
    res.json({ activeBusinessId: rows[0]?.active_business_id || null });
  } catch (e) {
    console.error('GET /api/businesses/active error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.setActive = async (req, res) => {
  try {
    const uid = req.user?.id;
    const body = req.body || {};
    const businessId = body.businessId ?? body.activeBusinessId;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });
    if (!businessId) return res.status(400).json({ error: 'businessId requerido' });

    const { rows: belongs } = await pool.query(`
      SELECT 1
        FROM app_businesses b
        LEFT JOIN user_businesses ub ON ub.business_id=b.id
       WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2)
       LIMIT 1
    `, [businessId, uid]);
    if (!belongs.length) return res.status(403).json({ error: 'forbidden' });

    await pool.query(`UPDATE app_users SET active_business_id=$1 WHERE id=$2`, [businessId, uid]);
    res.json({ ok: true, activeBusinessId: Number(businessId) });
  } catch (e) {
    console.error('PATCH /api/businesses/active error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.create = async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    const {
      name,
      branding = {},
      contact = {},
      address = {},
      social = {},
      lang = 'es-AR',
      currency = 'ARS',
      timezone = '-03:00',
      tax_id = '',
      maxi
    } = req.body || {};

    if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });

    // slug único
    let base = slugify(name);
    if (!base) base = 'local';
    let slug = base, i = 1;
    while (true) {
      const { rows } = await pool.query('SELECT 1 FROM app_businesses WHERE slug=$1 LIMIT 1', [slug]);
      if (!rows[0]) break;
      slug = `${base}-${++i}`;
    }

    // props base
    const props = { branding, contact, address, social, lang, currency, timezone, tax_id };

    // MAXI credenciales (cifrar si vienen)
    if (maxi?.email && maxi?.password && maxi?.codcli) {
      props.maxi = { email: maxi.email, codcli: maxi.codcli, pass_enc: encryptSecret(maxi.password) };
    }

    const { rows } = await pool.query(
      `INSERT INTO app_businesses (owner_id,name,slug,props)
       VALUES ($1,$2,$3,$4)
       RETURNING id, owner_id, name, slug, props, created_at`,
      [uid, name.trim(), slug, props]
    );
    const biz = rows[0];

    await pool.query(
      `INSERT INTO user_businesses (user_id, business_id, role)
       VALUES ($1,$2,'owner')
       ON CONFLICT (user_id, business_id) DO NOTHING`,
      [uid, biz.id]
    );
    await pool.query(`UPDATE app_users SET active_business_id=$1 WHERE id=$2`, [biz.id, uid]);


    // Backfill inicial 7 días (no bloqueante)
    setImmediate(async () => {
      try {
        await ensureInitialBackfillOnce({ businessId: biz.id });
        console.log(`[backfill:init] biz=${biz.id} OK`);
      } catch (e) {
        console.error(`[backfill:init] biz=${biz.id} ERROR:`, e?.message);
      }
      try {
        ensureInitialBackfillOnce({ businessId: biz.id, req }).catch(err =>
          console.warn('[init backfill]', biz.id, err.message)
        );
      } catch { } try {
        ensureInitialBackfillOnce({ businessId: biz.id, req }).catch(err =>
          console.warn('[init backfill]', biz.id, err.message)
        );
      } catch { }
    });

    res.status(201).json({ ok: true, business: biz, activeBusinessId: biz.id });
  } catch (e) {
    console.error('POST /api/businesses error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.getOne = async (req, res) => {
  if (!req.business) return res.status(404).json({ error: 'not_found' });
  res.json(attachBranding(req.business));
};

exports.update = async (req, res) => {
  const uid = req.user?.id;
  const businessId = req.businessId || Number(req.params.id) || req.business?.id;
  if (!uid) return res.status(401).json({ error: 'unauthorized' });
  if (!businessId) return res.status(404).json({ error: 'not_found' });

  const body = req.body || {};
  const name = (body.name ?? null);

  const incoming = body.props ? body.props : body;

  const branding = incoming.branding || null;
  const contact = incoming.contact || null;
  const address = incoming.address || null;
  const social = incoming.social || null;
  const description = (incoming.description ?? null);

  const patch = {
    ...(branding ? { branding } : {}),
    ...(contact ? { contact } : {}),
    ...(address ? { address } : {}),
    ...(social ? { social } : {}),
    ...(description !== null ? { description } : {})
  };
  const patchIsEmpty = Object.keys(patch).length === 0;

  const { rows } = await pool.query(
    `
    UPDATE app_businesses
       SET
         name = COALESCE($2, name),
         props = CASE
                   WHEN $3::jsonb IS NULL THEN props
                   ELSE COALESCE(props,'{}'::jsonb) || jsonb_strip_nulls($3::jsonb)
                 END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, slug, props, owner_id, created_at, updated_at;
    `,
    [businessId, name, patchIsEmpty ? null : patch]
  );

  const saved = attachBranding(rows[0]);
  return res.json({ business: saved });
};

exports.select = async (req, res) => {
  try {
    const uid = req.user?.id;
    const id = Number(req.params.id);

    if (!uid) return res.status(401).json({ error: 'unauthorized' });
    if (!id) return res.status(400).json({ error: 'id_required' });

    const { rows: belongs } = await pool.query(
      `SELECT 1
         FROM app_businesses b
         LEFT JOIN user_businesses ub ON ub.business_id = b.id
        WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id = $2)
        LIMIT 1`,
      [id, uid]
    );
    if (!belongs.length) return res.status(404).json({ error: 'not_found' });

    await pool.query(
      `UPDATE app_users SET active_business_id = $1 WHERE id = $2`,
      [id, uid]
    );

    res.json({ ok: true, activeBusinessId: id });
  } catch (e) {
    console.error('POST /businesses/:id/select error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.remove = async (req, res) => {
  const uid = req.user?.id;
  const bizId = Number(req.params?.id);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });
  if (!bizId || Number.isNaN(bizId)) return res.status(400).json({ error: 'invalid_business_id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const owner = await client.query(
      `SELECT id FROM app_businesses WHERE id=$1 AND owner_id=$2`,
      [bizId, uid]
    );
    if (owner.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }

    await client.query(
      `UPDATE app_users SET active_business_id = NULL WHERE id=$1 AND active_business_id=$2`,
      [uid, bizId]
    );

    const del = await client.query(
      `DELETE FROM app_businesses WHERE id=$1 AND owner_id=$2`,
      [bizId, uid]
    );
    if (del.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }

    await client.query('COMMIT');
    res.status(204).end();
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('DELETE /businesses/:id error', e);
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
};

/* ───────────────── Maxi: estado y credenciales ───────────────── */
exports.maxiStatus = async (req, res) => {
  try {
    const uid = req.user?.id;
    const bizId =
      Number(req.business?.id) ||
      Number(req.params?.id) ||
      Number(req.headers['x-business-id']);

    if (!uid) return res.status(401).json({ error: 'unauthorized' });
    if (!Number.isFinite(bizId)) return res.status(400).json({ error: 'invalid_business_id' });

    const { rows: access } = await pool.query(`
      SELECT b.props
        FROM app_businesses b
        LEFT JOIN user_businesses ub ON ub.business_id=b.id AND ub.user_id=$2
       WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id IS NOT NULL)
       LIMIT 1`, [bizId, uid]);
    if (!access[0]) return res.status(404).json({ error: 'not_found' });

    const props = access[0].props || {};
    const mx = props.maxi || {};
    const configured = !!(mx.email && mx.codcli && (mx.pass_enc || mx.password));
    res.json({ ok: true, business_id: bizId, configured, email: mx.email || null, codcli: mx.codcli || null });
  } catch (e) {
    console.error('GET /:id/maxi-status error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.maxiSave = async (req, res) => {
  const uid = req.user?.id;
  const bizId = Number(req.params?.id);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });
  if (!bizId || Number.isNaN(bizId)) return res.status(400).json({ error: 'invalid_business_id' });

  const { email, codcli } = req.body || {};
  const password = (req.body?.password ?? req.body?.pass)?.toString().trim();

  const { rows: belongs } = await pool.query(
    `SELECT 1
       FROM app_businesses b
       LEFT JOIN user_businesses ub ON ub.business_id = b.id
      WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id = $2)
      LIMIT 1`,
    [bizId, uid]
  );
  if (!belongs.length) return res.status(404).json({ error: 'not_found' });
  if (!email || !password || !codcli) return res.status(400).json({ error: 'missing_fields' });

  const maxi = { email: String(email).trim(), codcli: String(codcli).trim(), pass_enc: encryptSecret(password) };
  await pool.query(
    `UPDATE app_businesses
        SET props = jsonb_set(COALESCE(props,'{}'::jsonb), '{maxi}', $2::jsonb, true),
            updated_at = NOW()
      WHERE id = $1`,
    [bizId, maxi]
  );
  res.json({ ok: true, maxi: { email: maxi.email, codcli: maxi.codcli, configured: true } });
};

/* ───────────────── Subida de logo (POST /:id/logo) ───────────────── */
exports.uploadLogo = async (req, res, next) => {
  try {
    const biz = req.business;
    if (!biz?.id) return res.status(404).json({ error: 'not_found' });

    const urlFromBody = (req.body?.url || '').trim();
    let publicUrl = urlFromBody || null;

    if (req.file && req.file.filename) {
      publicUrl = `/uploads/logos/${req.file.filename}`;
    }

    if (!publicUrl) {
      return res.status(400).json({ error: 'missing_file_or_url' });
    }

    await pool.query(`
      UPDATE app_businesses
         SET props = COALESCE(props,'{}'::jsonb)
                    || jsonb_build_object(
                         'branding',
                         COALESCE((props->'branding')::jsonb,'{}'::jsonb)
                         || jsonb_build_object('logo_url',$2::text)
                       ),
             updated_at = now()
       WHERE id=$1
    `, [biz.id, publicUrl]);

    res.json({ ok: true, business_id: biz.id, logo_url: publicUrl });
  } catch (e) { next(e); }
};

/* ───────────────── Maxi: helpers para endpoints públicos de prueba ───────────────── */
async function maxiLogin({ email, pass, codcli }) {
  const res = await fetch(`${MAXI_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email, pass, cod_cli: String(codcli) }),
  });
  const j = await res.json().catch(() => ({}));
  if (!(j?.resultCode === 'SUCCESS' && j?.content?.tokenAccess)) {
    const msg = j?.resultDescription || `login_failed_${res.status}`;
    const err = new Error(msg); err.status = 502; throw err;
  }
  return j.content.tokenAccess;
}

async function maxiInvoiceByDate({ token, from, to }) {
  const u = new URL(`${MAXI_BASE}/estadisticas/invoicebydate`);
  u.searchParams.set('from', from);
  u.searchParams.set('to', to);
  const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json().catch(() => ({}));
  if (j?.resultCode !== 'SUCCESS') {
    const msg = j?.resultDescription || `fetch_failed_${res.status}`;
    const err = new Error(msg); err.status = 502; throw err;
  }
  const inner = j?.content?.content || j?.content || {};
  const arr = Array.isArray(inner?.facturas) ? inner.facturas : [];
  return arr.map(x => x?.factura).filter(Boolean);
}

// Divide un rango en ventanas de 7 días [from..to] (fechas en UTC)
function chunkRange7d(from, to) {
  const out = [];
  const d0 = new Date(from + 'T00:00:00Z'); // UTC
  const d1 = new Date(to + 'T00:00:00Z');
  if (!(+d0) || !(+d1) || d0 > d1) return out;
  let cur = new Date(d0);
  while (cur <= d1) {
    const end = new Date(cur);
    end.setUTCDate(end.getUTCDate() + 6);
    if (end > d1) end.setTime(d1.getTime());
    const f = ymd(cur);
    const t = ymd(end);
    out.push({ from: f, to: t });
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return out;
}

/* ───────────────── Maxi: endpoints públicos de prueba/diagnóstico ───────────────── */
exports.maxiItemsByDate = async (req, res, next) => {
  try {
    const biz = req.business;
    if (!biz) return res.status(404).json({ error: 'not_found' });

    const from = String(req.query?.from || '').slice(0, 10);
    const to = String(req.query?.to || '').slice(0, 10);
    if (!from || !to) return res.status(400).json({ error: 'missing_dates', hint: 'use ?from=YYYY-MM-DD&to=YYYY-MM-DD' });

    const { rows } = await pool.query(`SELECT props FROM app_businesses WHERE id=$1`, [biz.id]);
    const mx = (rows[0]?.props || {}).maxi || {};
    const pass = mx.pass_enc ? decryptSecretCompat(mx.pass_enc) : mx.password;
    if (!(mx.email && pass && mx.codcli)) return res.status(400).json({ error: 'maxi_not_configured' });

    const token = await maxiLogin({ email: mx.email, pass, codcli: mx.codcli });

    const windows = chunkRange7d(from, to);
    const agg = new Map(); // cod_art -> { cod_art, nombre_art, cantidad, total }
    let docs = 0;

    for (const w of windows) {
      const facturas = await maxiInvoiceByDate({ token, from: w.from, to: w.to });
      docs += facturas.length;

      for (const f of facturas) {
        const items = Array.isArray(f.items) ? f.items : [];
        for (const it of items) {
          const cod = Number(it.cod_art ?? it.codigo ?? it.id ?? 0);
          if (!cod) continue;
          const nombre = String(it.nombre_art ?? it.nombre ?? '').trim();
          const q = Number(it.cantidad ?? it.cant ?? 0) || 0;
          const p = Number(it.precio ?? 0) || 0;
          const key = String(cod);
          const cur = agg.get(key) || { cod_art: cod, nombre_art: nombre, cantidad: 0, total: 0 };
          cur.cantidad += q;
          cur.total += q * p;
          if (!cur.nombre_art && nombre) cur.nombre_art = nombre;
          agg.set(key, cur);
        }
      }
    }

    const items = Array.from(agg.values())
      .sort((a, b) => (b.cantidad - a.cantidad) || String(a.nombre_art).localeCompare(String(b.nombre_art)))
      .map(x => ({ ...x, total: r2(x.total) }));

    res.json({
      ok: true,
      range: { from, to },
      windows: windows.length,
      documents: docs,
      items,
      top20: items.slice(0, 20)
    });
  } catch (e) { next(e); }
};

function summarizeInvoices(invoices = []) {
  // Helpers
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const toISODate = (dmy) => {
    // admite 'DD/MM/YYYY' o 'YYYY-MM-DD'
    if (!dmy) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dmy)) return dmy;
    const m = String(dmy).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) {
      const [_, dd, mm, yyyy] = m;
      return `${yyyy}-${mm}-${dd}`;
    }
    return '';
  };

  // Preview (primeros 25), detectando ambos shapes
  const preview = invoices.slice(0, 25).map((row) => {
    // fullinvoicebydate → { factura: {...} }
    if (row?.factura) {
      const f = row.factura;
      return {
        numero: f.numero ?? null,
        fecha: toISODate(f.fecha || f.cabecera?.fecha),
        hora: f.cabecera?.hora ?? null,
        tipo: f.cabecera?.nombre_cpb ?? null,
        cod_cpb: f.cabecera?.cod_cpb ?? null,
        total: Number(f.total ?? f.cabecera?.total ?? 0),
        neto1: Number(f.cabecera?.neto1 ?? 0),
        iva1: Number(f.cabecera?.iva1 ?? 0),
        forma: f.cobro?.forma_cobro_tipo || f.cobro?.nombre || null,
        suc: f.cabecera?.prefijo ?? null,
        anulado: false
      };
    }

    // invoicebydate → { order: { orderData, orderItems } }
    const od = row?.order?.orderData || row?.orderData || null;
    if (od) {
      return {
        numero: od.orderId ?? null,
        fecha: toISODate(od.orderDate),
        hora: od.timeClose || od.timeOpen || null,
        tipo: null,
        cod_cpb: null,
        total: Number(od.totalSales ?? 0),
        neto1: 0,
        iva1: 0,
        forma: null,
        suc: null,
        anulado: false
      };
    }

    // Desconocido → generamos algo estable
    return {
      numero: null,
      fecha: '',
      hora: null,
      tipo: null,
      cod_cpb: null,
      total: 0,
      neto1: 0,
      iva1: 0,
      forma: null,
      suc: null,
      anulado: false
    };
  });

  // Totales por día
  const totalsByDay = {};
  let totalPeriodo = 0;
  let docs = 0;

  for (const row of invoices) {
    let fechaISO = '';
    let totalNum = 0;

    if (row?.factura) {
      const f = row.factura;
      fechaISO = toISODate(f.fecha || f.cabecera?.fecha);
      totalNum = Number(f.total ?? f.cabecera?.total ?? 0) || 0;
    } else if (row?.order?.orderData || row?.orderData) {
      const od = row.order?.orderData || row.orderData;
      fechaISO = toISODate(od.orderDate);
      totalNum = Number(od.totalSales ?? 0) || 0;
    }

    if (fechaISO) {
      totalsByDay[fechaISO] = r2((totalsByDay[fechaISO] || 0) + totalNum);
    }
    totalPeriodo += totalNum;
    docs += 1;
  }

  const byDay = Object.entries(totalsByDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dia, total]) => ({ dia, total }));

  return {
    documents: docs,
    total_periodo: r2(totalPeriodo),
    totals_by_day: byDay,
    sample: preview,
  };
}

exports.maxiRawInvoices = async (req, res, next) => {
  try {
    const biz = req.business;
    if (!biz) return res.status(404).json({ error: 'not_found' });

    const from = String(req.query?.from || '').slice(0, 10);
    const to = String(req.query?.to || '').slice(0, 10);
    if (!from || !to) {
      return res.status(400).json({
        error: 'missing_dates',
        hint: 'use ?from=YYYY-MM-DD&to=YYYY-MM-DD (rango máx. 7 días)'
      });
    }

    // 🔐 Usa el mismo flujo que el probe: bearer cacheado + endpoint correcto
    const bearer = await getBearer(biz.id, req);
    const payload = await fetchInvoiceByDate(from, to, bearer);

    // 🧩 Normaliza a un array de "factura" (sirve para el summarize)
    const invoices = extractFacturas(payload) || [];

    return res.json({
      ok: true,
      range: { from, to },
      raw_count: invoices.length,
      summary: summarizeInvoices(invoices),
      // raw: invoices // <-- habilitar solo para debug puntual
    });
  } catch (e) {
    next(e);
  }
};

/* ───────────────── Árbol de artículos (desde DB propia) ───────────────── */
exports.getArticlesTree = async (req, res, next) => {
  try {
    const businessId = Number(req.params.businessId);
    const tree = await fetchArticlesTree(businessId);
    res.json({ ok: true, tree });
  } catch (e) { next(e); }
};

/* ───────────────── Branding: setear URL directa ───────────────── */
exports.setBrandingUrl = async (req, res, next) => {
  try {
    const biz = req.business;
    const { logo_url } = req.body || {};
    const val = (typeof logo_url === 'string' && logo_url.trim()) ? logo_url.trim() : null;

    await require('../config/db').query(`
      UPDATE app_businesses
         SET props = COALESCE(props,'{}'::jsonb)
                   || jsonb_build_object('branding',
                        COALESCE((props->'branding')::jsonb, '{}'::jsonb)
                        || jsonb_build_object('logo_url', $2)
                      )
       WHERE id = $1
    `, [biz.id, val]);

    res.json({ ok: true, url: val, business_id: biz.id });
  } catch (e) { next(e); }
};

// ⬇️ ya los tenés arriba importados, los reutilizamos:
// const { ensureInitialBackfillOnce, runDailyAuto } = require('../services/salesSyncPolicy');
// const { fetchSalesRanged } = require('../services/maxiSalesService');
// const { upsertSalesBatch } = require('../services/salesStore');

/**
 * POST /api/businesses/:id/sync-sales-7d
 * Backfill inicial (7 días hasta AYER). Útil para forzar primer llenado.
 */
exports.syncSalesLast7d = async (req, res, next) => {
  try {
    const biz = req.business;
    const out = await require('../services/salesSyncPolicy')
      .ensureInitialBackfillOnce({ businessId: biz.id, req });
    res.json({ ok: true, mode: 'initial_backfill_7d', ...out });
  } catch (e) { next(e); }
};


/**
 * POST /api/businesses/:id/sync-sales?mode=auto|range|backfill_30d&from=YYYY-MM-DD&to=YYYY-MM-DD
 * - auto: incremental desde el último día hasta AYER
 * - range: fuerza un rango arbitrario (clamp a AYER), guarda en DB y recalcula agregados
 * - backfill_30d: igual a auto, pero si no hay datos hace backfill de 30 días
 */
exports.syncSales = async (req, res, next) => {
  try {
    const biz = req.business;
    if (!biz?.id) return res.status(404).json({ error: 'not_found' });

    const mode = String(req.query.mode || 'auto').toLowerCase();

    // Modo incremental diario: desde el último día sincronizado +1 hasta AYER (idempotente)
    if (mode === 'auto') {
      const out = await runDailyAuto({ businessId: biz.id, req });
      return res.json({ ok: true, business_id: biz.id, mode, ...out });
    }

    // Alias de “backfill_30d”: delega en la misma política que resuelve el primer backfill y luego incremental
    if (mode === 'backfill_30d') {
      const out = await runDailyAuto({ businessId: biz.id, req });
      return res.json({ ok: true, business_id: biz.id, mode, ...out });
    }

    // Rango arbitrario: trae crudo desde Maxi (clamp interno a AYER), normaliza y hace UPSERT
    if (mode === 'range') {
      const from = String(req.query.from || '').slice(0, 10);
      const to = String(req.query.to || '').slice(0, 10);
      if (!from || !to) {
        return res.status(400).json({ error: 'invalid_range', hint: 'use from=YYYY-MM-DD&to=YYYY-MM-DD' });
      }

      const rawFacturas = await fetchSalesRanged({ businessId: biz.id, from, to, req });
      const upsertOut = await upsertSalesBatch(biz.id, rawFacturas);

      return res.json({
        ok: true,
        business_id: biz.id,
        mode,
        from,
        to,
        fetched: rawFacturas.length,
        ...upsertOut, // { upserted, updated, minDay, maxDay, touchedDays? }
      });
    }

    return res.status(400).json({ error: 'invalid_mode', allowed: ['auto', 'range', 'backfill_30d'] });
  } catch (e) {
    next(e);
  }
};

exports.rebuildArticleMap = async (req, res, next) => {
  try {
    const businessId = Number(req.params.id);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid business id' });
    }

    await rebuildArticleMapFromAppArticles(businessId);

    return res.json({
      ok: true,
      business_id: businessId,
      rebuilt_from: 'app_articles',
    });
  } catch (err) {
    next(err);
  }
}