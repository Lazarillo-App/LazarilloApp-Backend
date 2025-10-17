// src/controllers/businessMaxiController.js
const { saveCreds, getStatus } = require('../services/maxiCredsService');

exports.saveMaxiCredentials = async (req, res) => {
  try {
    const businessId = Number(req.params.id);
    const { email, codcli, cod_cli, pass, pass_enc } = req.body || {};
    const cod = codcli ?? cod_cli;
    const { rows: ok } = await db.query(
      `SELECT 1 FROM app_businesses b
   LEFT JOIN user_businesses ub ON ub.business_id=b.id
   WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2) LIMIT 1`,
      [businessId, req.user?.id]
    );
    if (!ok.length) return res.status(403).json({ error: 'forbidden' });
    await saveCreds(businessId, { email, codcli: cod, pass, pass_enc });
    const status = await getStatus(businessId);
    res.json({ ok: true, status });
  } catch (e) {
    if (e.message === 'missing_fields') {
      return res.status(400).json({ error: 'missing_fields', need: ['email', 'codcli', 'pass|pass_enc'] });
    }
    console.error('saveMaxiCredentials error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.maxiStatus = async (req, res) => {
  try {
    const businessId = Number(req.params.id);
    const s = await getStatus(businessId);
    res.json(s);
  } catch (e) {
    res.status(500).json({ error: 'internal' });
  }
};
