// Asume que tu auth middleware ya setea req.user con { id, role, ... }
// Si no, importa jwt y decodifica aquí con tu JWT_SECRET.
module.exports = function requireAdmin(req, res, next) {
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'FORBIDDEN' });
  next();
};
