// utils/getBusinessId.js
module.exports = function getBusinessId(req) {
  const hdr =
    req.header('X-Business-Id') ||
    req.headers['x-business-id'] ||
    req.query.businessId;

  if (hdr) {
    const n = Number(hdr);
    if (Number.isFinite(n) && n > 0) return n;
  }

  if (req.business?.id) return Number(req.business.id);
  if (req.user?.active_business_id) return Number(req.user.active_business_id);

  return null;
};
