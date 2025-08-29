// controllers/businessController.js
const pool = require('../config/db');

exports.listMine = async (req, res) => {
  try {
    const uid = req.user?.id; // tu authMiddleware setea { id, email }
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    const { rows } = await pool.query(
      `
      SELECT DISTINCT b.id, b.name, b.color_hex, b.owner_id, b.created_at
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id = b.id
      WHERE (ub.user_id = $1 OR b.owner_id = $1)
      ORDER BY b.created_at ASC;
      `,
      [uid]
    );

    return res.json({ items: rows });
  } catch (e) {
    console.error('GET /api/businesses error:', e);
    return res.status(500).json({ error: 'internal' });
  }
};

exports.getActive = async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });
    const { rows } = await pool.query(
      `SELECT active_business_id FROM app_users WHERE id = $1`,
      [uid]
    );
    res.json({ activeBusinessId: rows[0]?.active_business_id || null });
  } catch (e) {
    console.error('GET /api/businesses/active error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.setActive = async (req, res) => {
  try {
    const uid = req.user?.id;
    const { businessId } = req.body || {};
    if (!uid) return res.status(401).json({ error: 'unauthorized' });
    if (!businessId) return res.status(400).json({ error: 'businessId requerido' });

    const { rows: belongs } = await pool.query(
      `
      SELECT 1
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id = b.id
      WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id = $2)
      LIMIT 1;
      `,
      [businessId, uid]
    );
    if (!belongs.length) return res.status(403).json({ error: 'forbidden' });

    await pool.query(
      `UPDATE app_users SET active_business_id = $1 WHERE id = $2`,
      [businessId, uid]
    );
    res.json({ ok: true, activeBusinessId: businessId });
  } catch (e) {
    console.error('PATCH /api/businesses/active error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

// Crear negocio
exports.create = async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    const { name, color_hex, brand_logo_url, brand_font } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name_required' });

    // crea el negocio
    const { rows } = await pool.query(
      `INSERT INTO app_businesses (owner_id, name, color_hex, brand_logo_url, brand_font)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, owner_id, name, color_hex, brand_logo_url, brand_font, created_at`,
      [uid, name, color_hex || null, brand_logo_url || null, brand_font || null]
    );
    const biz = rows[0];

    // relación N:N (por si en el futuro hay miembros)
    await pool.query(
      `INSERT INTO user_businesses (user_id, business_id, role)
       VALUES ($1,$2,'owner')
       ON CONFLICT (user_id,business_id) DO NOTHING`,
      [uid, biz.id]
    );

    // ponelo activo
    await pool.query(
      `UPDATE app_users SET active_business_id=$1 WHERE id=$2`,
      [biz.id, uid]
    );

    return res.status(201).json({ business: biz, activeBusinessId: biz.id });
  } catch (e) {
    console.error('POST /api/businesses error:', e);
    return res.status(500).json({ error: 'internal' });
  }
};

// Actualizar branding de un negocio existente
exports.update = async (req, res) => {
  try {
    const uid = req.user?.id;
    const id = Number(req.params.id);
    if (!uid) return res.status(401).json({ error: 'unauthorized' });
    if (!id) return res.status(400).json({ error: 'id_required' });

    // validar pertenencia (dueño o miembro)
    const { rows: belongs } = await pool.query(
      `SELECT 1
       FROM app_businesses b
       LEFT JOIN user_businesses ub ON ub.business_id = b.id
       WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id = $2)
       LIMIT 1;`,
      [id, uid]
    );
    if (!belongs.length) return res.status(403).json({ error: 'forbidden' });

    const { name, color_hex, brand_logo_url, brand_font } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE app_businesses
       SET name=COALESCE($2,name),
           color_hex=COALESCE($3,color_hex),
           brand_logo_url=COALESCE($4,brand_logo_url),
           brand_font=COALESCE($5,brand_font),
           updated_at=NOW()
       WHERE id=$1
       RETURNING id, owner_id, name, color_hex, brand_logo_url, brand_font, updated_at`,
      [id, name, color_hex, brand_logo_url, brand_font]
    );
    return res.json({ business: rows[0] });
  } catch (e) {
    console.error('PATCH /api/businesses/:id error:', e);
    return res.status(500).json({ error: 'internal' });
  }
};
