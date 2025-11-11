// middleware/allowAdminAsBusiness.js
module.exports = function allowAdminAsBusiness(req, _res, next) {
  if (req.user?.role !== 'app_admin') return next();
  const asId = Number(req.header('X-As-Business-Id') || req.query.as_business_id);
  if (Number.isFinite(asId)) {
    req.as_business_id = asId; // contexto virtual, no toca activeBusinessId
  }
  next();
};
