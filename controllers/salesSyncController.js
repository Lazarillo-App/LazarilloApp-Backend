/* eslint-disable no-console */
'use strict';

const { getBearer } = require('../services/maxiSalesService');
const { runWindow } = require('../services/salesSyncPolicy');

// GET /businesses/:id/maxi-ping
exports.maxiPing = async (req, res) => {
  try {
    const biz = req.business;
    // Si hay credenciales válidas en props, getBearer logrará loguear y cachear el token.
    const token = await getBearer(biz.id, req);
    return res.json({
      ok: true,
      configured: true,
      connected: !!token,
      email: biz?.props?.maxi?.email || biz?.props?.maxi_credentials?.email || null,
      codcli: biz?.props?.maxi?.codcli || biz?.props?.maxi_credentials?.codcli || null,
    });
  } catch (e) {
    const msg = String(e?.message || '');
    const configured = !/Faltan credenciales Maxi/i.test(msg);
    return res.json({ ok: false, configured, connected: false, error: msg });
  }
};

// (Opcional) Admin wrapper legado → delega al flujo nuevo por ventana
// POST /admin/businesses/:id/sync-sales?from=YYYY-MM-DD&to=YYYY-MM-DD
exports.adminSyncSales = async (req, res) => {
  try {
    const biz = req.business;                // seteado por allowAdminAsBusiness
    const from = (req.query.from || req.body?.from || '').slice(0,10);
    const to   = (req.query.to   || req.body?.to   || '').slice(0,10);
    if (!from || !to) return res.status(400).json({ error: 'from_to_required' });

    const out = await runWindow({ businessId: biz.id, days: 7, req }); // ignora days; usa from/to internos
    // Si querés respetar from/to exactos, podés exponer otro helper en salesSyncPolicy o llamar fetch+upsert directo.
    return res.json({ ok: true, business_id: biz.id, sales: out });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: 'internal', message: e.message || 'sync_failed' });
  }
};
