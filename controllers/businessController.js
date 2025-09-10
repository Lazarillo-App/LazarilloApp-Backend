// controllers/businessController.js

const pool = require('../config/db');
const { encryptSecret, decryptSecret } = require('../utils/cryptoField');

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

const slugify = (s = '') =>
  String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

exports.create = async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    const {
      name,
      branding = {},
      contact = {},
      address = {},
      social = {},
      lang = 'es-AR',
      currency = 'ARS',
      timezone = '-03:00',
      tax_id = '',
      // opcional: credenciales MAXI inline
      maxi
    } = req.body || {};

    if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });

    // slug único
    let base = slugify(name);
    if (!base) base = 'local';
    let slug = base, i = 1;
    while (true) {
      const { rows } = await pool.query('SELECT 1 FROM app_businesses WHERE slug=$1 LIMIT 1', [slug]);
      if (!rows[0]) break;
      slug = `${base}-${++i}`;
    }

    // props base
    const props = { branding, contact, address, social, lang, currency, timezone, tax_id };

    // si vienen credenciales MAXI al crear, las guardo cifradas
    if (maxi?.email && maxi?.password && maxi?.codcli) {
      props.maxi = { email: maxi.email, codcli: maxi.codcli, pass_enc: encryptSecret(maxi.password) };
    }

    const { rows } = await pool.query(
      `INSERT INTO app_businesses (owner_id,name,slug,props)
       VALUES ($1,$2,$3,$4)
       RETURNING id, owner_id, name, slug, color_hex, props, created_at`,
      [uid, name.trim(), slug, props]
    );
    const biz = rows[0];

    // set activo por comodidad
    await pool.query(`UPDATE app_users SET active_business_id=$1 WHERE id=$2`, [biz.id, uid]);

    return res.status(201).json({ ok: true, business: biz, activeBusinessId: biz.id });
  } catch (e) {
    console.error('POST /api/businesses error:', e);
    return res.status(500).json({ error: 'internal' });
  }
};

// Alias para seleccionar rápidamente un negocio
exports.select = async (req, res) => {
  try {
    const uid = req.user?.id;
    const id = Number(req.params.id);
    if (!uid) return res.status(401).json({ error: 'unauthorized' });
    if (!id) return res.status(400).json({ error: 'id_required' });

    const { rows: belongs } = await pool.query(
      `SELECT 1
       FROM app_businesses b
       LEFT JOIN user_businesses ub ON ub.business_id=b.id
       WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2)
       LIMIT 1`, [id, uid]
    );
    if (!belongs.length) return res.status(403).json({ error: 'forbidden' });

    await pool.query(`UPDATE app_users SET active_business_id=$1 WHERE id=$2`, [id, uid]);
    res.json({ ok: true, activeBusinessId: id });
  } catch (e) {
    console.error('POST /api/businesses/:id/select error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

// controllers/businessController.js  (añadir helpers y handlers Maxi)

exports.maxiStatus = async (req, res) => {
  try {
    const uid = req.user?.id; const id = Number(req.params.id);
    if (!uid || !id) return res.status(400).json({ error: 'bad_request' });

    // pertenencia
    const { rows: ok } = await pool.query(`
      SELECT props FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id=b.id
      WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2) LIMIT 1`, [id, uid]);
    if (!ok[0]) return res.status(403).json({ error: 'forbidden' });

    const props = ok[0].props || {};
    const mx = props.maxi || {};
    const configured = !!(mx.email && mx.codcli && (mx.pass_enc || mx.password));
    res.json({
      configured,
      email: mx.email || null,
      codcli: mx.codcli || null
    });
  } catch (e) {
    console.error('GET /:id/maxi-status error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.maxiSave = async (req, res) => {
  try {
    const uid = req.user?.id; const id = Number(req.params.id);
    if (!uid || !id) return res.status(400).json({ error: 'bad_request' });

    const { email, password, codcli } = req.body || {};
    if (!email || !password || !codcli) return res.status(400).json({ error: 'missing_fields' });

    // pertenencia
    const { rows: ok } = await pool.query(`
      SELECT 1 FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id=b.id
      WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2) LIMIT 1`, [id, uid]);
    if (!ok.length) return res.status(403).json({ error: 'forbidden' });

    const maxi = { email, codcli, pass_enc: encryptSecret(password) };
    const { rows } = await pool.query(`
      UPDATE app_businesses
      SET props = jsonb_set(COALESCE(props,'{}'::jsonb), '{maxi}', $2::jsonb, true),
          updated_at = NOW()
      WHERE id=$1
      RETURNING props
    `, [id, maxi]);

    res.json({ ok: true, maxi: { email, codcli, configured: true } });
  } catch (e) {
    console.error('POST /:id/maxi-credentials error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

async function callMaxiArticles({ email, password, codcli, from, to }) {
  // ⚠️ Pega acá tu lógica actual de obtener token y luego artículos.
  // Ejemplo-esqueleto:
  const BASE = process.env.MAXI_BASE_URL;
  // 1) token
  const tRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: email, password })
  });
  if (!tRes.ok) throw new Error('maxi_login_failed');
  const { token } = await tRes.json();

  // 2) artículos
  const aRes = await fetch(`${BASE}/articulos?codcli=${encodeURIComponent(codcli)}&desde=${from}&hasta=${to}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!aRes.ok) throw new Error('maxi_fetch_failed');
  const items = await aRes.json();
  return Array.isArray(items) ? items : (items?.data || []);
}

exports.maxiArticles = async (req, res) => {
  try {
    const uid = req.user?.id; const id = Number(req.params.id);
    const { from = '2025-01-01', to = '2025-04-01' } = req.query || {};
    if (!uid || !id) return res.status(400).json({ error: 'bad_request' });

    // props + pertenencia
    const { rows } = await pool.query(`
      SELECT props FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id=b.id
      WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2) LIMIT 1`, [id, uid]);
    if (!rows[0]) return res.status(403).json({ error: 'forbidden' });

    const mx = (rows[0].props || {}).maxi || {};
    const password = mx.pass_enc ? decryptSecret(mx.pass_enc) : mx.password;

    if (!(mx.email && password && mx.codcli)) return res.status(400).json({ error: 'maxi_not_configured' });

    const items = await callMaxiArticles({ email: mx.email, password, codcli: mx.codcli, from, to });
    res.json({ items });
  } catch (e) {
    console.error('GET /:id/maxi-articles error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
// controllers/businessController.js  (agregar)
exports.getOne = async (req, res) => {
  try {
    const uid = req.user?.id;
    const id = Number(req.params.id);
    if (!uid || !id) return res.status(400).json({ error: 'bad_request' });

    const { rows } = await pool.query(`
      SELECT b.id, b.owner_id, b.name, b.slug, b.color_hex, b.props, b.created_at, b.updated_at
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id = b.id
      WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2)
      LIMIT 1
    `, [id, uid]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ business: rows[0] });
  } catch (e) {
    console.error('GET /api/businesses/:id error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.remove = async (req, res) => {
  try {
    const uid = req.user?.id;
    const id = Number(req.params.id);
    if (!uid || !id) return res.status(400).json({ error: 'bad_request' });

    // validar pertenencia
    const { rows: ok } = await pool.query(`
      SELECT 1
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id=b.id
      WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2) LIMIT 1
    `, [id, uid]);
    if (!ok.length) return res.status(403).json({ error: 'forbidden' });

    // si el usuario lo tenía activo, lo limpia
    await pool.query(`UPDATE app_users SET active_business_id=NULL WHERE id=$1 AND active_business_id=$2`, [uid, id]);

    // borra (cascada elimina branches + user_businesses)
    await pool.query(`DELETE FROM app_businesses WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/businesses/:id error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
