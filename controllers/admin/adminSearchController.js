// controllers/admin/adminSearchController.js
const db = require('../../config/db');

/**
 * GET /admin/search?q=
 * Buscador global simple: usuarios + negocios + organizaciones por ILIKE,
 * combinados en un único JSON. Sin full-text ni índices nuevos.
 */
exports.globalSearch = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ ok: true, users: [], businesses: [], organizations: [] });

    const like = `%${q}%`;

    const [users, businesses, organizations] = await Promise.all([
      db.query(
        `SELECT id, name, email FROM app_users
          WHERE email ILIKE $1 OR COALESCE(name,'') ILIKE $1
          ORDER BY created_at DESC LIMIT 5`,
        [like]
      ),
      db.query(
        `SELECT id, name FROM app_businesses WHERE name ILIKE $1
          ORDER BY created_at DESC LIMIT 5`,
        [like]
      ),
      db.query(
        `SELECT id, name, display_name FROM organizations WHERE name ILIKE $1 OR COALESCE(display_name,'') ILIKE $1
          ORDER BY created_at DESC LIMIT 5`,
        [like]
      ),
    ]);

    res.json({
      ok: true,
      users: users.rows,
      businesses: businesses.rows,
      organizations: organizations.rows,
    });
  } catch (e) {
    console.error('ADMIN_SEARCH_FAILED:', e);
    res.status(500).json({ error: 'internal' });
  }
};
