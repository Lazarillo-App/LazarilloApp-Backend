// middleware/requireAdmin.js
module.exports = function requireAdmin(req, res, next) {
  try {
    const role = req.user?.role || req.user?.payload?.role;
    if (role === 'admin') return next();
    return res.status(403).json({ error: 'forbidden_admin_only' });
  } catch (e) {
    return res.status(403).json({ error: 'forbidden_admin_only' });
  }
};
