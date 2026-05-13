/* eslint-disable no-console */
const pool = require('../config/db');
const { decryptSecretCompat } = require('../utils/cryptoField');
const { autoAssignNewArticles } = require('../services/autoGroupAssignment');
const { notifyAutoAssign } = require('../services/notificationService');
const { fetchMaxiInsumos, normalizarInsumosMaxi } = require('../services/maxiSuppliesService');

// fetch nativo (Node 18+) o fallback a node-fetch
const fetchNative =
  (typeof globalThis.fetch === 'function')
    ? ((...args) => globalThis.fetch(...args))
    : require('node-fetch');

const BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = Number(process.env.MAXI_FETCH_TIMEOUT_MS || 30000);
const FETCH_RETRIES = Number(process.env.MAXI_FETCH_RETRIES || 2);

const { query } = require('../config/db');

/* ======================= Utils básicos ======================= */
function simpleHash(str = '') {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
const norm = s => String(s ?? '').trim();
const orSinCategoria = s => (norm(s) || 'Sin categoría');
const orSinSubrubro = s => (norm(s) || 'Sin subrubro');

// num "seguro" reutilizable en todo el archivo
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * Extrae el ID de artículo de Maxi usando SIEMPRE el código visible (codart/codigoArticulo)
 * y dejando id/idArticulo solo como fallback.
 */
const getArticuloId = (o = {}) => {
  const id = num(
    o.codart ??
    o.codigo ??
    o.codigoArticulo ??
    o.id ??
    o.idArticulo ??
    o.articulo_id,
    NaN
  );
  return Number.isFinite(id) ? id : NaN;
};

function parseDate(zd, fallback) {
  if (zd == null || zd === '') return new Date(fallback);
  if (zd instanceof Date) return Number.isNaN(+zd) ? new Date(fallback) : zd;
  if (typeof zd === 'number') { const d = new Date(zd); return Number.isNaN(+d) ? new Date(fallback) : d; }
  const d = new Date(String(zd)); return Number.isNaN(+d) ? new Date(fallback) : d;
}
function ymd(d) {
  if (!(d instanceof Date) || Number.isNaN(+d)) d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }

/* ========== Fetch con timeout + reintentos (429/5xx) ========== */
async function fetchWithRetry(url, options = {}, { retries = FETCH_RETRIES, timeout = FETCH_TIMEOUT_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort('timeout'), timeout);
    try {
      const res = await fetchNative(url, { ...options, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return res;
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
        await new Promise(r => setTimeout(r, 200 * (attempt + 1) ** 2));
        continue;
      }
      const txt = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} - ${txt.slice(0, 200)}`); err.status = res.status;
      throw err;
    } catch (e) {
      clearTimeout(t); lastErr = e;
      if (attempt < retries) { await new Promise(r => setTimeout(r, 200 * (attempt + 1) ** 2)); continue; }
      throw lastErr;
    }
  }
  throw lastErr || new Error('fetchWithRetry unknown error');
}

/* =================== MAXI: login y artículos =================== */
async function maxiLogin({ email, password, codcli }) {
  const res = await fetchWithRetry(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email, pass: password, cod_cli: String(codcli) })
  });
  const j = await res.json().catch(() => ({}));
  if (j?.resultCode !== 'SUCCESS' || !j?.content?.tokenAccess) {
    const id = j?.resultId || 'login_failed';
    throw new Error(`maxi_login_failed_${id}`);
  }
  return j.content.tokenAccess;
}

/**
 * Trae menú extendido (menuweb/menuextendido) y flatea a artículos con SWAP:
 *   app.categoria = subrubro Maxi
 *   app.subrubro  = rubro Maxi
 */
async function fetchMaxiArticles({ token, from, to }) {
  const u = new URL(`${BASE}/menuweb/menuextendido`);
  if (from) u.searchParams.set('fechaInicio', from);
  if (to) u.searchParams.set('fechaFin', to);

  const res = await fetchWithRetry(u.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json().catch(() => ({}));
  if (j?.resultCode !== 'SUCCESS') throw new Error('maxi_articles_fetch_failed');

  const root = Array.isArray(j?.content)
    ? j.content
    : Array.isArray(j?.menu?.content)
      ? j.menu.content
      : Array.isArray(j?.data?.content)
        ? j.data.content
        : [];

  const items = [];
  const seen = new Set();

  const isArticle = (o = {}) => {
    const hasId = ['id', 'idArticulo', 'codart', 'codigo', 'codigoArticulo'].some(k => k in o);
    const hasInfo = ['descripcion', 'descripcionl', 'nombre', 'precio', 'precioVenta', 'importe'].some(k => k in o);
    return hasId && hasInfo;
  };

  const getName = (o) => String(o?.descripcion ?? o?.descripcionl ?? o?.nombre ?? '').trim();

  const pushArt = (o, { rubroNombre, subrubroNombre }) => {
    // Usar SIEMPRE el código Maxi (codart / codigo / codigoArticulo)
    const id = getArticuloId(o);
    if (!Number.isFinite(id) || seen.has(id)) return;
    seen.add(id);

    items.push({
      id,
      nombre: getName(o),
      categoria: orSinCategoria(subrubroNombre), // SWAP
      subrubro: orSinSubrubro(rubroNombre),     // SWAP
      precio: num(o.precio ?? o.precioVenta ?? o.importe, 0),
      costo: num(o.costo ?? o.costoPromedio, 0),
      raw: o,
    });
  };

  for (const rubro of root) {
    const rubroNombre =
      String(
        rubro?.nombre ??
        rubro?.rubroNombre ??
        rubro?.rubro?.descripcion ??
        rubro?.rubro ??
        ''
      ).trim() || 'Sin subrubro'; // rubro Maxi → subrubro app

    const artsRubro = Array.isArray(rubro?.articulos) ? rubro.articulos : [];
    for (const a of artsRubro) if (isArticle(a)) pushArt(a, { rubroNombre, subrubroNombre: '' });

    const subrubros = Array.isArray(rubro?.subrubros) ? rubro.subrubros : [];
    for (const s of subrubros) {
      const subrubroNombre =
        String(s?.nombre ?? s?.nombreSubRubro ?? s?.subRubro?.descripcion ?? s?.subrubro ?? '').trim() || 'Sin subrubro';

      const arts = Array.isArray(s?.articulos) ? s.articulos : [];
      for (const a of arts) if (isArticle(a)) pushArt(a, { rubroNombre, subrubroNombre });

      const subs2 = Array.isArray(s?.subrubros) ? s.subrubros : [];
      for (const s2 of subs2) {
        const subSubNombre =
          String(s2?.nombre ?? s2?.nombreSubRubro ?? s2?.subRubro?.descripcion ?? s2?.subrubro ?? '').trim()
          || subrubroNombre;
        const arts2 = Array.isArray(s2?.articulos) ? s2.articulos : [];
        for (const a of arts2) if (isArticle(a)) pushArt(a, { rubroNombre, subrubroNombre: subSubNombre });
      }
    }
  }
  return { items, raw: root };
}

/* ========== Upsert en public.maxi_articles (chunked) ========== */
async function upsertArticles({ client, businessId, items }) {
  if (!items?.length) return 0;
  const CHUNK = 500;
  let total = 0;

  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let p = 1;

    for (const it of slice) {
      const id = getArticuloId(it);
      if (!Number.isFinite(id)) continue;

      const nombre = (String(it.nombre ?? it.descripcion ?? it.descripcionl ?? '').slice(0, 200) || null);
      const categoria = orSinCategoria(it.categoria);
      const subrubro = orSinSubrubro(it.subrubro);
      const precio = num(it.precio ?? it.precioVenta ?? it.importe, 0);
      const costo = num(it.costo ?? it.costoPromedio, 0);

      values.push(`($${p},$${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7}::jsonb,NOW())`);
      params.push(
        businessId,
        id,
        nombre,
        categoria,
        subrubro,
        precio,
        costo,
        JSON.stringify(it.raw ?? it._raw ?? it)
      );
      p += 8;
    }
    if (!values.length) continue;

    const sql = `
      INSERT INTO public.maxi_articles
        (business_id, articulo_id, nombre, categoria, subrubro, precio, costo, raw, updated_at)
      VALUES ${values.join(',')}
      ON CONFLICT (business_id, articulo_id)
      DO UPDATE SET
        nombre   = EXCLUDED.nombre,
        categoria= EXCLUDED.categoria,
        subrubro = EXCLUDED.subrubro,
        precio   = EXCLUDED.precio,
        costo    = EXCLUDED.costo,
        raw      = EXCLUDED.raw,
        updated_at = NOW()
    `;
    await client.query(sql, params);
    total += slice.length;
  }
  return total;
}

/* ============================ Handlers ============================ */

/**
 * POST /businesses/:id/sync
 * body: { scope: 'articles' | 'all', from?, to? }
 */
exports.syncNow = async (req, res) => {
  const biz = req.business;
  const userId = req.user?.id; // 🆕 Capturamos el user_id

  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });

  const { scope = 'articles', from, to } = req.body || {};
  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const f = ymd(parseDate(from, startOfMonth));
  const t = ymd(parseDate(to, yesterday));

  const mx = (biz?.props || {}).maxi || (biz?.props || {}).maxi_credentials || {};
  const password = mx.pass_enc ? decryptSecretCompat(mx.pass_enc) : (mx.password || mx.pass || '');
  if (!(mx.email && password && mx.codcli)) {
    return res.status(400).json({ error: 'maxi_not_configured' });
  }

  const client = await pool.connect();
  try {
    const token = await maxiLogin({ email: mx.email, password, codcli: mx.codcli });

    let upserted = 0;
    let mapped = 0;
    let cacheHash = null;
    let autoAssigned = 0;

    if (scope === 'articles' || scope === 'all') {
      const { items, raw } = await fetchMaxiArticles({ token, from: f, to: t });

      const rawStr = JSON.stringify(raw ?? []);
      cacheHash = String(require('crypto').createHash('sha1').update(rawStr).digest('hex'));
      await pool.query(`
        INSERT INTO public.maxi_menu_cache (business_id, payload, hash, updated_at)
        VALUES ($1, $2::jsonb, $3, NOW())
        ON CONFLICT (business_id, hash) DO UPDATE SET updated_at = NOW()
      `, [biz.id, rawStr, cacheHash]);

      await client.query('BEGIN');
      upserted = await upsertArticles({ client, businessId: biz.id, items });

      const r = await client.query(`
        WITH src AS (
          SELECT business_id, articulo_id,
                 NULLIF(btrim(categoria),'') AS categoria,
                 NULLIF(btrim(subrubro),'')  AS subrubro
          FROM public.maxi_articles
          WHERE business_id = $1
        )
        INSERT INTO public.maxi_article_map (business_id, articulo_id, categoria, subrubro, updated_at)
        SELECT business_id,
               articulo_id,
               COALESCE(categoria,'[PENDIENTE]'),
               COALESCE(subrubro,'[PENDIENTE]'),
               NOW()
        FROM src
        ON CONFLICT (business_id, articulo_id) DO UPDATE
          SET categoria = EXCLUDED.categoria,
              subrubro  = EXCLUDED.subrubro,
              updated_at= NOW()
      `, [biz.id]);
      mapped = r.rowCount || 0;

      await client.query('COMMIT');

      // 🆕 AUTO-ASIGNACIÓN POST-SYNC + NOTIFICACIÓN
      try {
        const result = await autoAssignNewArticles(biz.id);
        autoAssigned = result.assigned;

        if (autoAssigned > 0) {
          console.log(`[syncNow] Auto-asignados ${autoAssigned} artículos a agrupaciones existentes`);

          // 🆕 CREAR NOTIFICACIÓN
          if (userId) {
            await notifyAutoAssign({
              businessId: biz.id,
              userId,
              result
            });
          }
        }
      } catch (autoErr) {
        console.error('[syncNow] Error en auto-asignación (no crítico):', autoErr.message);
        // No rompemos el sync por esto
      }
    }

    return res.json({
      ok: true,
      business_id: biz.id,
      scope: 'articles',
      from: f,
      to: t,
      upserted,
      mapped,
      cacheHash,
      auto_assigned: autoAssigned // 🆕
    });

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    const msg = String(e?.message || '');
    if (msg.includes('maxi_login_failed') || e.status === 401 || msg.includes('401')) {
      return res.status(401).json({ error: 'unauthorized', detail: 'Maxi login failed/401' });
    }
    if (msg.includes('maxi_not_configured')) {
      return res.status(400).json({ error: 'maxi_not_configured' });
    }
    console.error('syncNow error:', e?.stack || e);
    return res.status(500).json({ error: 'internal', detail: msg });
  } finally {
    client.release();
  }
};

/**
 * GET /businesses/:id/articles (lista plana)
 */
exports.listArticlesFromDB = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });

  const { principalId, assignedIds, orgId } = await getOrgArticleContext(biz.id, pool);
  const isSubBusiness = orgId && Number(biz.id) !== Number(principalId);

  let allowedIds = null;
  if (isSubBusiness) {
    // Artículos propios del subnegocio (en sus agrupaciones reales)
    const { rows: subAgRows } = await pool.query(
      `SELECT ag.articulos, ag.app_articles_ids
         FROM agrupaciones ag
        WHERE ag.business_id = $1
          AND ag.moved_to_business_id IS NULL
          AND ag.nombre NOT ILIKE 'Sin Agrupac%'
          AND ag.nombre NOT ILIKE 'Sin Agrupar%'
          AND ag.nombre NOT ILIKE 'Discontinuados'
          AND ag.nombre NOT ILIKE 'Descontinuados'`,
      [biz.id]
    );

    allowedIds = new Set();
    for (const ag of subAgRows) {
      const arts = Array.isArray(ag.articulos) ? ag.articulos
        : (typeof ag.articulos === 'string' ? JSON.parse(ag.articulos || '[]') : []);
      const appIds = Array.isArray(ag.app_articles_ids) ? ag.app_articles_ids
        : (typeof ag.app_articles_ids === 'string' ? JSON.parse(ag.app_articles_ids || '[]') : []);
      for (const a of arts) {
        const id = Number(a?.id ?? a?.articulo_id ?? a);
        if (id > 0) allowedIds.add(id);
      }
      for (const id of appIds) { const n = Number(id); if (n > 0) allowedIds.add(n); }
    }

    // Artículos libres (no asignados a ningún subnegocio) también son visibles
    if (assignedIds) {
      const { rows: allRows } = await pool.query(
        `SELECT articulo_id FROM public.maxi_articles WHERE business_id = $1`,
        [principalId]
      );
      for (const r of allRows) {
        const id = Number(r.articulo_id);
        if (id > 0 && !assignedIds.has(id)) allowedIds.add(id);
      }
    }
  }

  const { rows } = await pool.query(
    `SELECT
       ma.articulo_id AS id, ma.nombre, ma.categoria, ma.subrubro, ma.precio, ma.costo, ma.raw,
       (aa.props->>'precio1')::numeric AS precio1,
       (aa.props->>'precio2')::numeric AS precio2,
       (aa.props->>'precio3')::numeric AS precio3,
       (aa.props->>'precio4')::numeric AS precio4,
       'maxi' AS origen_tabla
       FROM public.maxi_articles ma
       LEFT JOIN app_articles aa ON aa.id = ma.articulo_id AND aa.business_id = $1
      WHERE ma.business_id = $1

     UNION ALL

     -- Artículos creados manualmente (ID negativo, no tienen equivalencia en maxi_articles)
     SELECT
       aa.id          AS id,
       aa.name        AS nombre,
       aa.rubro       AS categoria,
       aa.subrubro    AS subrubro,
       aa.price       AS precio,
       NULL           AS costo,
       '{}'::jsonb    AS raw,
       NULL AS precio1, NULL AS precio2, NULL AS precio3, NULL AS precio4,
       'manual' AS origen_tabla
       FROM app_articles aa
      WHERE aa.business_id = $1
        AND aa.id < 0
        AND (aa.props->>'origen') = 'manual'

      ORDER BY categoria, subrubro, nombre`,
    [principalId]
  );

  const items = allowedIds !== null
    ? rows.filter(r => allowedIds.has(Number(r.id)))
    : rows;

  res.json({ items });
};

/**
 * GET /businesses/:id/articles/tree (subrubro > categoría > artículos)
 */

/* ─────────────────────────────────────────────────────────────────────────
 * getOrgContext(bizId, pool)
 * 
 * Para cualquier negocio de una org, devuelve:
 *   - principalId: el negocio principal (el más antiguo, no from_group)
 *   - assignedIds: Set de article_ids que están asignados en ALGUNA agrupación
 *                  real (no Sin Agrupación, no Discontinuados) de CUALQUIER
 *                  negocio de la org
 * 
 * Si el negocio no tiene org, devuelve { principalId: bizId, assignedIds: null }
 * (null = no filtrar)
 * ─────────────────────────────────────────────────────────────────────── */
async function getOrgArticleContext(bizId, pool) {
  // ¿Tiene org?
  const { rows: bizRows } = await pool.query(
    `SELECT organization_id, created_from FROM app_businesses WHERE id = $1`, [bizId]
  );
  const biz = bizRows[0];
  if (!biz?.organization_id) return { principalId: bizId, assignedIds: null };

  // Negocio principal de la org
  const { rows: principalRows } = await pool.query(
    `SELECT id FROM app_businesses
      WHERE organization_id = $1 AND created_from != 'from_group'
      ORDER BY created_at ASC LIMIT 1`,
    [biz.organization_id]
  );
  const principalId = principalRows[0]?.id || bizId;

  // Todos los IDs asignados en agrupaciones reales de cualquier negocio de la org
  // (excluyendo Sin Agrupación y Discontinuados — esos son el "flotante")
  const { rows: agRows } = await pool.query(
    `SELECT ag.articulos, ag.app_articles_ids
       FROM agrupaciones ag
       JOIN app_businesses b ON b.id = ag.business_id
      WHERE b.organization_id = $1
        AND ag.moved_to_business_id IS NULL
        AND ag.nombre NOT ILIKE 'Sin Agrupac%'
        AND ag.nombre NOT ILIKE 'Sin Agrupar%'
        AND ag.nombre NOT ILIKE 'Discontinuados'
        AND ag.nombre NOT ILIKE 'Descontinuados'`,
    [biz.organization_id]
  );

  const assignedIds = new Set();
  for (const ag of agRows) {
    const arts = Array.isArray(ag.articulos) ? ag.articulos
      : (typeof ag.articulos === 'string' ? JSON.parse(ag.articulos || '[]') : []);
    const appIds = Array.isArray(ag.app_articles_ids) ? ag.app_articles_ids
      : (typeof ag.app_articles_ids === 'string' ? JSON.parse(ag.app_articles_ids || '[]') : []);
    for (const a of arts) {
      const id = Number(a?.id ?? a?.articulo_id ?? a);
      if (id > 0) assignedIds.add(id);
    }
    for (const id of appIds) { const n = Number(id); if (n > 0) assignedIds.add(n); }
  }

  return { principalId, assignedIds, orgId: biz.organization_id };
}

exports.listArticlesTreeFromDB = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });
  try {
    const { principalId, assignedIds, orgId } = await getOrgArticleContext(biz.id, pool);
    const isSubBusiness = orgId && Number(biz.id) !== Number(principalId);

    // Para subnegocios: calcular qué artículos le pertenecen
    // = los que están en sus propias agrupaciones (no globales)
    let allowedIds = null; // null = sin filtro (principal o sin org)
    if (isSubBusiness) {
      const { rows: subAgRows } = await pool.query(
        `SELECT ag.articulos, ag.app_articles_ids
           FROM agrupaciones ag
          WHERE ag.business_id = $1
            AND ag.moved_to_business_id IS NULL
            AND ag.nombre NOT ILIKE 'Sin Agrupac%'
            AND ag.nombre NOT ILIKE 'Sin Agrupar%'
            AND ag.nombre NOT ILIKE 'Discontinuados'
            AND ag.nombre NOT ILIKE 'Descontinuados'`,
        [biz.id]
      );

      allowedIds = new Set();
      for (const ag of subAgRows) {
        const arts = Array.isArray(ag.articulos) ? ag.articulos
          : (typeof ag.articulos === 'string' ? JSON.parse(ag.articulos || '[]') : []);
        const appIds = Array.isArray(ag.app_articles_ids) ? ag.app_articles_ids
          : (typeof ag.app_articles_ids === 'string' ? JSON.parse(ag.app_articles_ids || '[]') : []);
        for (const a of arts) {
          const id = Number(a?.id ?? a?.articulo_id ?? a);
          if (id > 0) allowedIds.add(id);
        }
        for (const id of appIds) { const n = Number(id); if (n > 0) allowedIds.add(n); }
      }

      // También incluir artículos sin asignar a ningún subnegocio (son del principal = visibles desde todos)
      // Un artículo es "sin asignar" si no está en ninguna agrupación real de ningún subnegocio
      // assignedIds ya tiene TODOS los asignados en la org — los que NO están ahí son libres
      // Los libres son visibles desde cualquier subnegocio (aparecen en Sin Agrupación global)
      if (assignedIds) {
        const { rows: allRows } = await pool.query(
          `SELECT articulo_id FROM public.maxi_articles WHERE business_id = $1`,
          [principalId]
        );
        for (const r of allRows) {
          const id = Number(r.articulo_id);
          if (id > 0 && !assignedIds.has(id)) allowedIds.add(id);
        }
      }
    }

    const { rows } = await pool.query(
      `SELECT articulo_id, nombre, categoria, subrubro, precio
         FROM public.maxi_articles
        WHERE business_id = $1
        ORDER BY subrubro, categoria, nombre`,
      [principalId]
    );

    // También traer artículos manuales (ID negativo, origen='manual')
    const { rows: manualRows } = await pool.query(
      `SELECT id AS articulo_id, name AS nombre, rubro AS categoria, subrubro, price AS precio
         FROM app_articles
        WHERE business_id = $1
          AND id < 0
          AND (props->>'origen') = 'manual'
        ORDER BY subrubro, rubro, name`,
      [principalId]
    );

    const allRows = [...rows, ...manualRows];
    const bySub = new Map();
    for (const r of allRows) {
      // Para subnegocios: solo incluir artículos permitidos
      if (allowedIds !== null && !allowedIds.has(Number(r.articulo_id))) continue;

      const sub = (r.subrubro && r.subrubro.trim()) || 'Sin subrubro';
      const cat = (r.categoria && r.categoria.trim()) || 'Sin categoría';
      if (!bySub.has(sub)) bySub.set(sub, new Map());
      const byCat = bySub.get(sub);
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push({ id: r.articulo_id, nombre: r.nombre, precio: r.precio ?? null });
    }

    const tree = Array.from(bySub.entries()).map(([subrubro, byCat]) => ({
      subrubro,
      categorias: Array.from(byCat.entries()).map(([categoria, articulos]) => ({ categoria, articulos })),
    }));
    const resumen = {
      subrubros: tree.length,
      categorias: tree.reduce((a, s) => a + (s.categorias?.length || 0), 0),
      articulos: tree.reduce((a, s) => a + s.categorias.reduce((x, c) => x + (c.articulos?.length || 0), 0), 0),
    };
    res.json({ ok: true, resumen, tree });
  } catch (e) {
    console.error('listArticlesTreeFromDB error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

/**
 * GET /businesses/:id/maxi-articles-proxy?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
exports.maxiArticlesProxy = async (req, res) => {
  const biz = req.business;
  if (!biz?.id) return res.status(400).json({ error: 'no_active_business' });

  const today = new Date();
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const yesterday = addDays(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())), -1);
  const from = ymd(parseDate(req.query.from, startOfMonth));
  const to = ymd(parseDate(req.query.to, yesterday));

  try {
    const mx = (biz?.props || {}).maxi || (biz?.props || {}).maxi_credentials || {};
    const password = mx.pass_enc ? decryptSecretCompat(mx.pass_enc) : (mx.password || mx.pass || '');
    if (!(mx.email && password && mx.codcli)) return res.status(400).json({ error: 'maxi_not_configured' });

    const token = await maxiLogin({ email: mx.email, password, codcli: mx.codcli });
    const { items } = await fetchMaxiArticles({ token, from, to });
    res.json({ from, to, items });
  } catch (e) {
    console.error('maxiArticlesProxy error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

// controllers/syncController.js  (reemplazá solo salesSummaryFromDB)

/* salesSummaryFromDB - versión top-N agregada (usa columnas reales) */
exports.salesSummaryFromDB = async (req, res, next) => {
  try {
    const biz = req.business;
    const { from, to, limit = 50, q } = req.query;

    const fromYmd = String(from || '').slice(0, 10);
    const toYmd = String(to || '').slice(0, 10);

    if (!fromYmd || !toYmd) {
      return res.status(400).json({ ok: false, error: 'from_to_required' });
    }

    const lim = Number(limit) || 50;
    const search = (q && String(q).trim()) || null;

    if (biz.created_from === 'from_group' && biz.organization_id) {
      const { rows: rootRows } = await pool.query(
        `SELECT id FROM app_businesses
         WHERE organization_id = $1
           AND (created_from IS NULL OR created_from = 'manual' OR created_from = 'onboarding')
         ORDER BY id ASC LIMIT 1`,
        [biz.organization_id]
      );
      if (rootRows.length) {
        salesBizId = rootRows[0].id;
        console.log(`[salesSummaryFromDB] Subnegocio ${biz.id} → ventas en negocio raíz ${salesBizId}`);
      }

      // Obtener article_ids del subnegocio SOLO desde agrupaciones (no maxi_articles)
      const { rows: agrupRows } = await pool.query(
        `SELECT articulos FROM agrupaciones
          WHERE business_id = $1 AND moved_to_business_id IS NULL`,
        [biz.id]
      );
      const ids = new Set();
      for (const row of agrupRows) {
        const arr = Array.isArray(row.articulos)
          ? row.articulos
          : (typeof row.articulos === 'string' ? JSON.parse(row.articulos || '[]') : []);
        for (const item of arr) {
          const id = Number(item?.id ?? item?.articulo_id ?? item);
          if (Number.isFinite(id) && id > 0) ids.add(id);
        }
      }
      subArticleIds = ids.size > 0 ? Array.from(ids) : [];
      console.log(`[salesSummaryFromDB] Subnegocio ${biz.id} filtra ${subArticleIds.length} artículos`);
    }

    /* Totales por día desde sales_daily */
    const { rows: totRows } = await pool.query(
      `SELECT
        COALESCE(SUM(total), 0)::numeric AS total,
        COALESCE(SUM(tx_count), 0)::int  AS tx_count
       FROM sales_daily
       WHERE business_id = $1
         AND day BETWEEN $2::date AND $3::date`,
      [salesBizId, fromYmd, toYmd]
    );
    const total = Number(totRows[0]?.total || 0);
    const txCount = Number(totRows[0]?.tx_count || 0);

    const params = [salesBizId, fromYmd, toYmd];
    let whereExtra = '';

    // Filtro por artículos del subnegocio
    if (subArticleIds !== null) {
      if (subArticleIds.length === 0) {
        // Subnegocio sin artículos asignados → devolver vacío
        return res.json({
          ok: true,
          business_id: biz.id,
          sales_biz_id: salesBizId,
          from: fromYmd,
          to: toYmd,
          total: 0,
          tx_count: 0,
          limit: lim,
          items: [],
        });
      }
      params.push(subArticleIds);
      whereExtra += `\nAND s.article_id = ANY($${params.length}::int[])`;
    }

    if (search) {
      params.push(`%${search}%`);
      whereExtra += `
    AND (
      COALESCE(ma.nombre, a.name, ('Artículo #' || s.article_id::text))
      ILIKE $${params.length}
    )`;
    }

    const sqlItems = `
WITH preferred AS (
  SELECT DISTINCT ON (business_id, day, article_id)
    business_id, day, article_id, qty, amount
  FROM sales_daily_items
  WHERE business_id = $1
    AND day BETWEEN $2::date AND $3::date
    AND COALESCE(NULLIF(article_id::text,''), '0')::bigint <> 0
  ORDER BY business_id, day, article_id,
    CASE WHEN source = 'csv' THEN 0 ELSE 1 END
)
SELECT
  s.article_id,
  COALESCE(MAX(ma.nombre), MAX(a.name), 'Artículo #' || s.article_id::text) AS nombre,
  COALESCE(MAX(ma.categoria), MAX(m.categoria), MAX(c.nombre), '[PENDIENTE]') AS rubro,
  COALESCE(MAX(ma.subrubro), MAX(m.subrubro), MAX(sr.nombre), '[PENDIENTE]') AS subrubro,
  SUM(s.qty)::numeric    AS qty,
  SUM(s.amount)::numeric AS amount
FROM preferred s
LEFT JOIN maxi_articles   ma ON ma.business_id = s.business_id AND ma.articulo_id = s.article_id
LEFT JOIN maxi_article_map m  ON m.business_id  = s.business_id AND m.articulo_id  = s.article_id
LEFT JOIN app_articles     a  ON a.business_id  = s.business_id AND a.id           = s.article_id
LEFT JOIN categorias       c  ON c.id = a.categoria_id
LEFT JOIN subrubros        sr ON sr.id = a.subrubro_id
${whereExtra}
GROUP BY s.article_id
ORDER BY qty DESC
LIMIT ${lim};
`;

    const { rows } = await pool.query(sqlItems, params);

    return res.json({
      ok: true,
      business_id: biz.id,
      sales_biz_id: salesBizId,
      from: fromYmd,
      to: toYmd,
      total,
      tx_count: txCount,
      limit: lim,
      items: rows.map((r) => ({
        article_id: r.article_id,
        article_title: r.nombre || '',
        rubro: r.rubro || '',
        subrubro: r.subrubro || '',
        qty: Number(r.qty || 0),
        amount: Number(r.amount || 0),
      })),
    });


  } catch (e) {
    next(e);
  }
};


/**
 * GET /api/businesses/:id/sales/:articuloId?from&to&groupBy=day
 *
 * Serie por ARTÍCULO usando sales_daily_items:
 * {
 *   ok, business_id, articulo_id, from, to, groupBy,
 *   total,
 *   items: [ { label: 'YYYY-MM-DD', qty, amount } ]
 * }
 */
exports.salesSeriesFromDB = async function salesSeriesFromDB(req, res, next) {
  try {
    const businessId = parseInt(req.params.id, 10);
    const articuloId = parseInt(req.params.articuloId, 10);
    const { from, to, groupBy = 'day' } = req.query;

    if (!businessId || !articuloId || !from || !to) {
      return res.status(400).json({
        error: 'missing_params',
        required: ['businessId', 'articuloId', 'from', 'to']
      });
    }

    console.log('[salesSeriesFromDB] 📊 Consultando ventas:', { businessId, articuloId, from, to, groupBy });

    // PASO 1: Resolver en qué negocio están realmente las ventas.
    const { rows: bizRows } = await pool.query(
      `SELECT id FROM app_businesses WHERE id = $1`,
      [businessId]
    );
    if (!bizRows.length) {
      return res.status(404).json({ error: 'business_not_found' });
    }

    const salesBizId = businessId;

    // PASO 2: Obtener el nombre del artículo desde maxi_articles.
    // Buscamos en el negocio donde están las ventas (salesBizId) y también en el negocio
    // original (businessId) por si los artículos están cargados con otro business_id.
    const { rows: artRows } = await pool.query(
      `SELECT articulo_id AS id, nombre
       FROM maxi_articles
       WHERE articulo_id = $1
         AND business_id = ANY($2::int[])
       LIMIT 1`,
      [articuloId, [salesBizId, businessId]]
    );

    const articleNombre = artRows[0]?.nombre || `#${articuloId}`;
    console.log(`[salesSeriesFromDB] ✅ Artículo ${articuloId}: "${articleNombre}", buscando ventas en negocio ${salesBizId}`);

    // PASO 3: Construir el GROUP BY según el parámetro
    let dateTrunc;
    if (groupBy === 'day') {
      dateTrunc = 'sdi.day::text';
    } else if (groupBy === 'week') {
      dateTrunc = `date_trunc('week', sdi.day)::date::text`;
    } else if (groupBy === 'month') {
      dateTrunc = `date_trunc('month', sdi.day)::date::text`;
    } else {
      return res.status(400).json({
        error: 'invalid_group_by',
        valid_values: ['day', 'week', 'month']
      });
    }

    // PASO 4: Buscar ventas directamente por article_id en el negocio donde están las ventas.
    // No hace falta ningún JOIN — article_id en sales_daily_items ES el articulo_id de maxi_articles.
    const salesQuery = `
      SELECT
        ${dateTrunc} AS label,
        SUM(qty)     AS qty,
        SUM(amount)  AS amount
      FROM sales_daily_items sdi
      WHERE sdi.business_id = $1
        AND sdi.article_id  = $2
        AND sdi.day >= $3::date
        AND sdi.day <= $4::date
      GROUP BY label
      ORDER BY label
    `;

    const { rows } = await pool.query(salesQuery, [salesBizId, articuloId, from, to]);

    const items = rows.map(row => ({
      label: row.label,
      qty: parseInt(row.qty || 0, 10),
      amount: parseFloat(row.amount || 0)
    }));

    const total = items.reduce((sum, item) => sum + item.qty, 0);

    console.log('[salesSeriesFromDB] ✅ Resultados:', { articuloId, itemsCount: items.length, total });

    return res.json({
      total,
      items,
      meta: {
        article_id: articuloId,
        article_nombre: articleNombre,
        business_id: businessId,
        sales_biz_id: salesBizId,
        from,
        to,
        groupBy
      }
    });

  } catch (err) {
    console.error('[salesSeriesFromDB] ❌ Error:', err);
    return next(err);
  }
}

// ============================ CHANGE SETS (INSUMOS) ============================

async function getCanonicalInsumosCount(client, businessId) {
  const { rows } = await client.query(`
    SELECT COUNT(*)::int AS cnt
    FROM insumos
    WHERE business_id = $1
      AND activo = true
  `, [businessId]);
  return rows?.[0]?.cnt ?? 0;
}

function riskForCounts({ canonicalCount, incomingCount, minKeepRatio = 0.8 }) {
  const missingPercent = canonicalCount > 0
    ? (1 - (incomingCount / canonicalCount)) * 100
    : 0;

  const blocked = canonicalCount > 0 && incomingCount < canonicalCount * minKeepRatio;

  const reasons = [];
  if (blocked) {
    reasons.push(
      `Incoming ${incomingCount} < ${(minKeepRatio * 100).toFixed(0)}% de canonical ${canonicalCount} (missing ~${missingPercent.toFixed(1)}%)`
    );
  }

  return { blocked, missingPercent, reasons, minKeepRatio };
}

/**
 * POST /api/businesses/:businessId/sync/insumos/detect
 * Crea un change set para insumos.
 * - NO aplica cambios
 * - Si Maxi viene “cortado” (ej 220 vs 1170), lo bloquea (status = error)
 */
exports.detectInsumosChanges = async (req, res) => {
  const businessId = Number(req.params.businessId);
  const userId = req.user?.id ? Number(req.user.id) : null;

  if (!Number.isFinite(businessId) || businessId <= 0) {
    return res.status(400).json({ error: 'bad_request', message: 'businessId inválido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Canonical = lo fijo en tu DB
    const canonicalCount = await getCanonicalInsumosCount(client, businessId);

    // Incoming = lo que vino de Maxi
    const raw = await fetchMaxiInsumos({ businessId, req });
    const incoming = normalizarInsumosMaxi(raw);
    const incomingCount = incoming.length;

    // Policy (si existe en sync_policies)
    const { rows: polRows } = await client.query(`
      SELECT policies
      FROM sync_policies
      WHERE business_id = $1
      LIMIT 1
    `, [businessId]);

    const minKeepRatio =
      Number(polRows?.[0]?.policies?.insumos?.minKeepRatio) ||
      Number(process.env.SYNC_INSUMOS_MIN_KEEP_RATIO || 0.8);

    const risk = riskForCounts({ canonicalCount, incomingCount, minKeepRatio });

    const summary = {
      counts: { canonical: canonicalCount, incoming: incomingCount },
      risk,
    };

    // Si viene roto -> status error (bloqueado)
    const status = risk.blocked ? 'error' : 'pending';

    // Por ahora guardamos change set sin diff detallado (lo hacemos después)
    const changes = [];

    const { rows: csRows } = await client.query(`
      INSERT INTO sync_change_sets
        (business_id, scope, status, created_by, summary, changes, source_snapshot)
      VALUES
        ($1, 'insumos', $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
      RETURNING id, status, created_at, summary
    `, [
      businessId,
      status,
      userId,
      JSON.stringify(summary),
      JSON.stringify(changes),
      JSON.stringify({ source: 'maxi', fetched_at: new Date().toISOString() }),
    ]);

    const cs = csRows?.[0];

    // Notificación (si querés)
    if (userId) {
      await client.query(`
        INSERT INTO sync_notifications (business_id, user_id, type, title, message, metadata)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      `, [
        businessId,
        userId,
        'error', // usamos tipo existente del CHECK
        risk.blocked ? 'Detect insumos BLOQUEADO' : 'Detect insumos listo',
        risk.blocked
          ? 'Maxi devolvió menos insumos de lo esperado. No se aplicará nada hasta revisar.'
          : 'Hay cambios detectados para revisar y aprobar.',
        JSON.stringify({ change_set_id: cs.id, summary }),
      ]);
    }

    await client.query('COMMIT');

    return res.json({
      ok: true,
      change_set_id: cs.id,
      status: cs.status,
      summary: cs.summary,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[detectInsumosChanges] error:', e);
    return res.status(500).json({ error: 'internal', detail: e.message });
  } finally {
    client.release();
  }
};