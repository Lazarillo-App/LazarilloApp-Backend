// middleware/requireAppAdmin.js
module.exports = function requireAppAdmin(req, res, next) {
  const u = req.user;
  if (!u) return res.status(401).json({ error: 'unauthorized' });

  // ¿chequea role plano?
  if (u.role === 'app_admin') return next();

  // ¿o una bandera?
  if (u.props?.is_admin === true) return next();

  return res.status(403).json({ error: 'forbidden_admin_only' });
};
