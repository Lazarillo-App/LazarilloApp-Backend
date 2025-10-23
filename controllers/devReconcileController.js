const { fetchSalesRanged } = require('../services/maxiSalesService');
const pool = require('../config/db');

exports.reconcile = async (req,res,next) => {
  try {
    const businessId = Number(req.query.businessId || req.business?.id);
    const from = req.query.from, to = req.query.to;
    if (!businessId || !from || !to) return res.status(400).json({ error:'params' });

    const { rows } = await pool.query(
      `SELECT i.article_id::text AS id, COALESCE(MAX(i.name),'') AS name, SUM(i.quantity)::numeric AS qty
         FROM app_sales_items i
         JOIN app_sales s ON s.id=i.sale_id
        WHERE s.business_id=$1
          AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
        GROUP BY 1`,
      [businessId, from, to]
    );
    const dbMap = new Map(rows.map(r => [r.id, { name: r.name, qty: Number(r.qty) }]));

    const raw = await fetchSalesRanged({ businessId, from, to, req });
    const mxMap = new Map();
    for (const f of raw) {
      const det = f?.items || f?.detalle || [];
      for (const it of det) {
        const id = String(it?.cod_art ?? it?.codigoArticulo ?? '');
        if (!id) continue;
        const q = Number(it?.cantidad ?? it?.unidades ?? 0);
        const prev = mxMap.get(id) || { name: it?.nombre || it?.descripcion || '', qty: 0 };
        prev.qty += q;
        if (!prev.name) prev.name = it?.nombre || it?.descripcion || '';
        mxMap.set(id, prev);
      }
    }

    const all = new Set([...dbMap.keys(), ...mxMap.keys()]);
    const diffs = [];
    for (const id of all) {
      const a = dbMap.get(id) || { name:'', qty:0 };
      const b = mxMap.get(id) || { name:'', qty:0 };
      if (Math.abs(a.qty - b.qty) > 1e-6) {
        diffs.push({ id, name: a.name || b.name, db_qty: a.qty, maxi_qty: b.qty, delta: +(a.qty - b.qty).toFixed(3) });
      }
    }

    res.json({ ok:true, business_id: businessId, range:{from,to}, diffs, db_count: rows.length, maxi_count: mxMap.size });
  } catch (e) { next(e); }
};
