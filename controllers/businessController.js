const pool = require('../config/db');
const { setCreds, getCreds, hasCreds } = require('../services/maxiCredsService');

exports.create = async (req, res) => {
  const { name, tax_id, timezone, currency, url_slug } = req.body;
  if (!name) return res.status(400).json({ error: 'name_required' });

  const { rows } = await pool.query(
    `INSERT INTO businesses (owner_id,name,tax_id,timezone,currency,url_slug)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [req.user.id, name, tax_id || null, timezone || null, currency || null, url_slug || null]
  );
  const biz = rows[0];

  await pool.query(
    `INSERT INTO user_business_roles (user_id,business_id,role) VALUES ($1,$2,'owner')
     ON CONFLICT DO NOTHING`,
    [req.user.id, biz.id]
  );

  // si no tenía negocio activo, setear este
  await pool.query(
    `UPDATE app_users SET active_business_id = COALESCE(active_business_id, $2) WHERE id = $1`,
    [req.user.id, biz.id]
  );

  res.status(201).json(biz);
};

exports.listMine = async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, (SELECT role FROM user_business_roles ubr WHERE ubr.user_id=$1 AND ubr.business_id=b.id) as role
       FROM businesses b
       JOIN user_business_roles ubr ON ubr.business_id=b.id
      WHERE ubr.user_id=$1
      ORDER BY b.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
};

exports.update = async (req, res) => {
  const { id } = req.params;
  // validar acceso
  const { rows: r } = await pool.query(
    `SELECT 1 FROM user_business_roles WHERE user_id=$1 AND business_id=$2`,
    [req.user.id, id]
  );
  if (!r[0]) return res.status(403).json({ error: 'no_access' });

  const { name, tax_id, timezone, currency, url_slug, primary_color, secondary_color, logo_url } = req.body;
  const { rows } = await pool.query(
    `UPDATE businesses
        SET name=COALESCE($2,name), tax_id=COALESCE($3,tax_id),
            timezone=COALESCE($4,timezone), currency=COALESCE($5,currency),
            url_slug=COALESCE($6,url_slug), primary_color=COALESCE($7,primary_color),
            secondary_color=COALESCE($8,secondary_color), logo_url=COALESCE($9,logo_url),
            updated_at=now()
      WHERE id=$1
      RETURNING *`,
    [id, name, tax_id, timezone, currency, url_slug, primary_color, secondary_color, logo_url]
  );
  res.json(rows[0]);
};

exports.setActive = async (req, res) => {
  const { id } = req.params;
  const { rows: r } = await pool.query(
    `SELECT 1 FROM user_business_roles WHERE user_id=$1 AND business_id=$2`,
    [req.user.id, id]
  );
  if (!r[0]) return res.status(403).json({ error: 'no_access' });
  await pool.query(`UPDATE app_users SET active_business_id=$2 WHERE id=$1`, [req.user.id, id]);
  res.json({ ok: true, active_business_id: id });
};

exports.saveMaxiCreds = async (req, res) => {
  const { id } = req.params; // business id
  const { email, pass, cod_cli } = req.body;
  if (!email || !pass || !cod_cli) return res.status(400).json({ error: 'email_pass_cod_cli_required' });

  // validar acceso
  const { rows: r } = await pool.query(
    `SELECT 1 FROM user_business_roles WHERE user_id=$1 AND business_id=$2`,
    [req.user.id, id]
  );
  if (!r[0]) return res.status(403).json({ error: 'no_access' });

  await setCreds(id, { email, pass, cod_cli });
  res.json({ ok: true });
};

exports.maxiStatus = async (req, res) => {
  const { id } = req.params;
  const { rows: r } = await pool.query(
    `SELECT 1 FROM user_business_roles WHERE user_id=$1 AND business_id=$2`,
    [req.user.id, id]
  );
  if (!r[0]) return res.status(403).json({ error: 'no_access' });

  const ok = await hasCreds(id);
  const creds = ok ? await getCreds(id) : null;
  res.json({ hasCreds: ok, email: creds?.email || null });
};
