// middleware/forbidAppAdmin.js
module.exports = (req, res, next) => {
  if (req.user?.role === 'app_admin') {
    return res.status(403).json({ error: 'forbidden_for_app_admin' });
  }
  next();
};
