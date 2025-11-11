// middleware/requireBizRole.js
const ROLE_RANK = { viewer: 1, staff: 2, manager: 3, owner: 4 };

function requireBizRole(minRole = 'viewer') {
  const minRank = ROLE_RANK[minRole] ?? 999;
  return (req, res, next) => {
    // Necesita negocio cargado y membership
    if (!req.business) return res.status(400).json({ error: 'business_required' });
    if (!req.user?.id) return res.status(401).json({ error: 'auth_required' });
    if (!req.membership) return res.status(403).json({ error: 'no_membership' });

    const rank = ROLE_RANK[req.membership.role] ?? 0;
    if (rank < minRank) {
      return res.status(403).json({ error: 'forbidden_role', need: minRole, have: req.membership.role });
    }
    next();
  };
}

const requireOwner   = requireBizRole('owner');
const requireManager = requireBizRole('manager');
const requireStaff   = requireBizRole('staff');
const requireViewer  = requireBizRole('viewer');

module.exports = { requireBizRole, requireOwner, requireManager, requireStaff, requireViewer };
