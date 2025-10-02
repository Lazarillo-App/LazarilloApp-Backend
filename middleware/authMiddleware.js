// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'dev-secret';

module.exports = function authRequired(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'missing_token' });

    let payload;
    try { payload = jwt.verify(m[1], SECRET); }
    catch { return res.status(401).json({ error: 'invalid_token' }); }

    req.user = { id: payload.uid, email: payload.email };
    next();
  } catch (e) {
    console.error('authRequired error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
