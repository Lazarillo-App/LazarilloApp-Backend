// middleware/requireAppAdmin.js
module.exports = function requireAppAdmin(req, res, next) {
  if (req.user?.role !== 'app_admin') {
    return res.status(403).json({ error: 'forbidden_admin_only' });
  }
  next();
};
