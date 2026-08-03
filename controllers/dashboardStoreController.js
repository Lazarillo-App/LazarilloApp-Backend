// controllers/dashboardStoreController.js
// Handlers HTTP del almacén del Dashboard de Resultados.
// El businessId ya viene resuelto y validado por el middleware de acceso
// (req.businessId), igual que el resto de rutas /api/businesses/:bizId/...
const repo = require('../repos/dashboardStoreRepo');

// GET /api/businesses/:bizId/dashboard-store/:key
async function getOne(req, res) {
  try {
    const key = decodeURIComponent(req.params.key || '');
    if (!key) return res.status(400).json({ ok: false, error: 'key_required' });
    const value = await repo.get(req.businessId, key);
    if (value == null) return res.json({ ok: true, found: false, value: null });
    return res.json({ ok: true, found: true, key, value });
  } catch (e) {
    console.error('[dashboardStore.getOne]', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
}

// PUT /api/businesses/:bizId/dashboard-store/:key   body: { value }
async function setOne(req, res) {
  try {
    const key = decodeURIComponent(req.params.key || '');
    if (!key) return res.status(400).json({ ok: false, error: 'key_required' });
    const value = req.body?.value;
    if (typeof value !== 'string') {
      return res.status(400).json({ ok: false, error: 'value_must_be_string' });
    }
    await repo.set(req.businessId, key, value);
    return res.json({ ok: true, key });
  } catch (e) {
    console.error('[dashboardStore.setOne]', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
}

// DELETE /api/businesses/:bizId/dashboard-store/:key
async function deleteOne(req, res) {
  try {
    const key = decodeURIComponent(req.params.key || '');
    if (!key) return res.status(400).json({ ok: false, error: 'key_required' });
    const deleted = await repo.del(req.businessId, key);
    return res.json({ ok: true, key, deleted });
  } catch (e) {
    console.error('[dashboardStore.deleteOne]', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
}

// GET /api/businesses/:bizId/dashboard-store?prefix=movstock:
async function listKeys(req, res) {
  try {
    const prefix = req.query.prefix || '';
    const keys = await repo.list(req.businessId, prefix);
    return res.json({ ok: true, keys });
  } catch (e) {
    console.error('[dashboardStore.listKeys]', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
}

module.exports = { getOne, setOne, deleteOne, listKeys };
