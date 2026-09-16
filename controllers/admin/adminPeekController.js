// controllers/admin/adminPeekController.js
// Endpoints de solo lectura ("peek") que el admin usa para ver datos de un negocio
// puntual con fines de diagnóstico (nunca de escritura). Protegidos por
// middleware/allowAdminAsBusiness.js, no por loadActiveBusiness.
const pool = require('../../config/db');

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
function parseDate(v, f) { if (!v) return new Date(f); const d = v instanceof Date ? v : new Date(String(v)); return Number.isNaN(+d) ? new Date(f) : d; }

exports.peekVentasSummary = async (req, res) => {
  try {
    const bizId = req.businessId;
    if (!bizId) return res.status(400).json({ error: 'invalid_business' });

    const today = new Date();
    const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const yesterday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
    const from = ymd(parseDate(req.query.from, startOfMonth));
    const to   = ymd(parseDate(req.query.to,   yesterday));
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 5000);

    const { rows } = await pool.query(
      `
      SELECT s.articulo_id,
             COALESCE(a.nombre, '(sin nombre)') AS nombre,
             SUM(s.qty)::numeric   AS qty,
             SUM(s.amount)::numeric AS amount
        FROM public.maxi_sales_daily s
   LEFT JOIN public.maxi_articles a
          ON a.business_id = s.business_id AND a.articulo_id = s.articulo_id
       WHERE s.business_id = $1
         AND s.day >= $2::date AND s.day <= $3::date
    GROUP BY s.articulo_id, a.nombre
    ORDER BY amount DESC, qty DESC
       LIMIT $4
      `,
      [bizId, from, to, limit]
    );

    res.json({ ok: true, business_id: bizId, from, to, items: rows });
  } catch (e) {
    console.error('peekVentasSummary error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

/* ─────────────────── PEEK: Ventas series ───────────────────
   GET /admin/businesses/:id/ventas/by-article?articuloId=123&from=...&to=...&groupBy=day|week|month
*/
exports.peekVentasSeries = async (req, res) => {
  try {
    const bizId = req.businessId;
    const articuloId = Number(req.query.articuloId || req.params.articuloId);
    if (!bizId || !Number.isFinite(articuloId)) return res.status(400).json({ error: 'bad_request' });

    const today = new Date();
    const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const yesterday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
    const from = ymd(parseDate(req.query.from, startOfMonth));
    const to   = ymd(parseDate(req.query.to,   yesterday));
    const groupBy = ['day', 'week', 'month'].includes(String(req.query.groupBy)) ? req.query.groupBy : 'day';

    if (groupBy === 'day') {
      const { rows } = await pool.query(
        `
        SELECT day AS bucket,
               SUM(qty)::numeric AS qty,
               SUM(amount)::numeric AS amount
          FROM public.maxi_sales_daily
         WHERE business_id=$1 AND articulo_id=$2
           AND day >= $3::date AND day <= $4::date
      GROUP BY day
      ORDER BY bucket
        `,
        [bizId, articuloId, from, to]
      );
      return res.json({ ok: true, business_id: bizId, articuloId, from, to, groupBy, items: rows });
    }

    const { rows } = await pool.query(
      `
      SELECT date_trunc($5, day)::date AS bucket,
             SUM(qty)::numeric AS qty,
             SUM(amount)::numeric AS amount
        FROM public.maxi_sales_daily
       WHERE business_id=$1 AND articulo_id=$2
         AND day >= $3::date AND day <= $4::date
    GROUP BY bucket
    ORDER BY bucket
      `,
      [bizId, articuloId, from, to, groupBy]
    );
    res.json({ ok: true, business_id: bizId, articuloId, from, to, groupBy, items: rows });
  } catch (e) {
    console.error('peekVentasSeries error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

/* ─────────────────── PEEK: Articles tree ─────────────────── */
exports.peekArticlesTree = async (req, res) => {
  try {
    const bizId = req.businessId;
    if (!bizId) return res.status(400).json({ error: 'invalid_business' });

    const { rows } = await pool.query(
      `
      SELECT articulo_id, nombre, categoria, subrubro, precio
        FROM public.maxi_articles
       WHERE business_id = $1
    ORDER BY subrubro, categoria, nombre
      `,
      [bizId]
    );

    const bySub = new Map();
    for (const r of rows) {
      const sub = r.subrubro?.trim() || 'Sin subrubro';
      const cat = r.categoria?.trim() || 'Sin categoría';
      if (!bySub.has(sub)) bySub.set(sub, new Map());
      const byCat = bySub.get(sub);
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push({ id: r.articulo_id, nombre: r.nombre, precio: r.precio ?? null });
    }

    const tree = Array.from(bySub.entries()).map(([subrubro, byCat]) => ({
      subrubro,
      categorias: Array.from(byCat.entries()).map(([categoria, articulos]) => ({ categoria, articulos }))
    }));

    const resumen = {
      subrubros: tree.length,
      categorias: tree.reduce((a, s) => a + (s.categorias?.length || 0), 0),
      articulos: tree.reduce((a, s) => a + s.categorias.reduce((x, c) => x + (c.articulos?.length || 0), 0), 0),
    };

    res.json({ ok: true, business_id: bizId, resumen, tree });
  } catch (e) {
    console.error('peekArticlesTree error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

/* ─────────────────── PEEK: Maxi status ─────────────────── */
exports.peekMaxiStatus = async (req, res) => {
  try {
    const bizId = req.businessId;
    const { rows } = await pool.query(`SELECT props FROM app_businesses WHERE id=$1 LIMIT 1`, [bizId]);
    const props = rows[0]?.props || {};
    const mx = props.maxi || props.maxi_credentials || {};
    const email = mx.email || mx.user || null;
    const codcli = mx.codcli || mx.codigo || null;
    const configured = !!(email && (mx.pass_enc || mx.password || mx.pass) && codcli);
    res.json({ ok: true, business_id: bizId, configured, email, codcli });
  } catch (e) {
    console.error('peekMaxiStatus error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};

/* ─────────────────── PEEK: Maxi menú cache ─────────────────── */
exports.peekMaxiMenuCache = async (req, res) => {
  try {
    const bizId = req.businessId;
    const { rows } = await pool.query(
      `SELECT hash, payload, updated_at
         FROM public.maxi_menu_cache
        WHERE business_id=$1
     ORDER BY updated_at DESC
        LIMIT 1`,
      [bizId]
    );
    const row = rows[0] || null;
    res.json({ ok: true, business_id: bizId, cache: row });
  } catch (e) {
    console.error('peekMaxiMenuCache error:', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
};
