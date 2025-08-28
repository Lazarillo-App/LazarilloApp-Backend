const jwt = require('jsonwebtoken');

exports.authRequired = (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.uid, email: payload.email };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
};
