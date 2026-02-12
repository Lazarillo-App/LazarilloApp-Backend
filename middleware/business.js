const pool = require('../config/db');

// middleware/loadActiveBusiness.js
exports.loadActiveBusiness = async (req, res, next) => {
  try {
    if (req.user?.role === 'app_admin') {
      return res.status(403).json({ error: 'forbidden_for_app_admin' });
    }

    const uid = req.user?.id;                        // <-- FALTABA ESTO
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    const headerId = req.header('X-Business-Id');
    const queryId  = req.query.businessId;
    const paramId  = req.params.businessId || req.params.id;
    // ...
    // (el resto igual, pero los queries que usan $2 deben recibir uid)
  } catch (e) {
    console.error('loadActiveBusiness error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
