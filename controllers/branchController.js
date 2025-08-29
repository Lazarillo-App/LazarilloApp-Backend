const pool = require('../config/db');

exports.list = async (req, res) => {
  try {
    const uid = req.user?.id;
    const bid = Number(req.headers['x-business-id']);
    if (!uid || !bid) return res.status(400).json({ error: 'missing_ctx' });

    // valida pertenencia
    const { rows: ok } = await pool.query(
      `SELECT 1 FROM app_businesses b
       LEFT JOIN user_businesses ub ON ub.business_id=b.id
       WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2) LIMIT 1`, [bid, uid]);
    if (!ok.length) return res.status(403).json({ error: 'forbidden' });

    const { rows } = await pool.query(
      `SELECT id, name, logo_url, address, contacts, props, created_at
       FROM app_branches WHERE business_id=$1 ORDER BY created_at ASC`, [bid]);
    res.json({ items: rows });
  } catch (e) {
    console.error('GET /api/branches error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.create = async (req, res) => {
  try {
    const uid = req.user?.id;
    const bid = Number(req.headers['x-business-id']);
    const { name, logo_url, address={}, contacts={}, props={} } = req.body || {};
    if (!uid || !bid) return res.status(400).json({ error: 'missing_ctx' });
    if (!name) return res.status(400).json({ error: 'name_required' });

    const { rows: ok } = await pool.query(
      `SELECT 1 FROM app_businesses b
       LEFT JOIN user_businesses ub ON ub.business_id=b.id
       WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2) LIMIT 1`, [bid, uid]);
    if (!ok.length) return res.status(403).json({ error: 'forbidden' });

    const { rows } = await pool.query(
      `INSERT INTO app_branches (business_id,name,logo_url,address,contacts,props)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, name, logo_url, address, contacts, props, created_at`,
      [bid, name, logo_url || null, address, contacts, props]
    );
    res.status(201).json({ branch: rows[0] });
  } catch (e) {
    console.error('POST /api/branches error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
