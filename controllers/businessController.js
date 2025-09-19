// controllers/businessController.js
const pool = require('../config/db');
const { decryptSecretCompat, encryptSecret } = require('../utils/cryptoField');
const fetch = global.fetch || require('node-fetch');

// ------------------- Helpers -------------------
const slugify = (s = '') =>
  String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// ------------------- Negocios (CRUD + selección) -------------------
exports.listMine = async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    const { rows } = await pool.query(`
      SELECT DISTINCT b.id, b.name, b.color_hex, b.owner_id, b.created_at
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id = b.id
      WHERE (ub.user_id = $1 OR b.owner_id = $1)
      ORDER BY b.created_at ASC;
    `, [uid]);

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

    const { rows: belongs } = await pool.query(`
      SELECT 1
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id = b.id
      WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id = $2)
      LIMIT 1;
    `, [businessId, uid]);
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

    // credenciales MAXI cifradas si vienen
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

    await pool.query(`UPDATE app_users SET active_business_id=$1 WHERE id=$2`, [biz.id, uid]);

    return res.status(201).json({ ok: true, business: biz, activeBusinessId: biz.id });
  } catch (e) {
    console.error('POST /api/businesses error:', e);
    return res.status(500).json({ error: 'internal' });
  }
};

exports.getOne = async (req, res) => {
  try {
    // Gracias al middleware ya tenemos req.business si el :id es válido y pertenece
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    if (!req.business) return res.status(404).json({ error: 'not_found' });
    res.json({ business: req.business });
  } catch (e) {
    console.error('GET /api/businesses/:id error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.update = async (req, res) => {
  const uid = req.user?.id;
  const businessId = req.businessId;
  if (!uid) return res.status(401).json({ error: 'unauthorized' });
  if (!businessId) return res.status(404).json({ error: 'not_found' });

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
    [businessId, name, color_hex, brand_logo_url, brand_font]
  );
  return res.json({ business: rows[0] });
};

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

// controllers/businessController.js (solo el remove)
exports.remove = async (req, res) => {
  const uid   = req.user?.id;             // setea authRequired (JWT)
  const bizId = Number(req.params?.id);   // viene de /businesses/:id

  if (!uid)   return res.status(401).json({ error: 'unauthorized' });
  if (!bizId || Number.isNaN(bizId)) {
    return res.status(400).json({ error: 'invalid_business_id' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) chequear que el negocio exista y sea del usuario (ajustá si usás memberships)
    const owner = await client.query(
      `SELECT id FROM app_businesses WHERE id=$1 AND owner_id=$2`,
      [bizId, uid]
    );
    if (owner.rowCount === 0) {
      await client.query('ROLLBACK');
      // si no existe o no es tuyo, devolvemos 404 por seguridad
      return res.status(404).json({ error: 'not_found' });
    }

    // 2) si este negocio estaba activo para el usuario, limpiarlo
    await client.query(
      `UPDATE app_users
          SET active_business_id = NULL
        WHERE id=$1 AND active_business_id=$2`,
      [uid, bizId]
    );

    // 3) borrar el negocio (y en cascada si tenés FK con ON DELETE CASCADE)
    const del = await client.query(
      `DELETE FROM app_businesses WHERE id=$1 AND owner_id=$2`,
      [bizId, uid]
    );
    if (del.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }

    await client.query('COMMIT');
    return res.status(204).end(); // o res.json({ok:true}) si preferís 200
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('DELETE /businesses/:id error', e);
    return res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
};


// ------------------- MAXI (estado y credenciales) -------------------
exports.maxiStatus = async (req, res) => {
  const uid = req.user?.id;
  const businessId = req.businessId;
  if (!uid) return res.status(401).json({ error: 'unauthorized' });
  if (!businessId) return res.status(404).json({ error: 'not_found' });

  const { rows } = await pool.query(`SELECT props FROM app_businesses WHERE id=$1`, [businessId]);
  const props = rows[0]?.props || {};
  const mx = props.maxi || {};
  const configured = !!(mx.email && mx.codcli && (mx.pass_enc || mx.password));
  res.json({ configured, email: mx.email || null, codcli: mx.codcli || null });
};

exports.maxiSave = async (req, res) => {
  const uid = req.user?.id;
  const businessId = req.businessId;
  if (!uid) return res.status(401).json({ error: 'unauthorized' });
  if (!businessId) return res.status(404).json({ error: 'not_found' });

  const { email, password, codcli } = req.body || {};
  if (!email || !password || !codcli) return res.status(400).json({ error: 'missing_fields' });

  const maxi = { email, codcli, pass_enc: encryptSecret(password) };
  await pool.query(`
    UPDATE app_businesses
       SET props = jsonb_set(COALESCE(props,'{}'::jsonb), '{maxi}', $2::jsonb, true),
           updated_at = NOW()
     WHERE id=$1
  `, [businessId, maxi]);

  res.json({ ok: true, maxi: { email, codcli, configured: true } });
};

// ------------------- MAXI (helpers y proxy opcional) -------------------
async function callMaxiArticles({ email, password, codcli, from, to }) {
  const BASE = (process.env.MAXI_BASE_URL || '').replace(/\/+$/, '');

  const rLogin = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Accept':'application/json' },
    body: JSON.stringify({ email, pass: password, cod_cli: String(codcli) })
  });
  const jLogin = await rLogin.json();
  if (!(jLogin?.resultCode === 'SUCCESS' && jLogin?.content?.tokenAccess)) {
    throw new Error(`maxi_login_failed_${rLogin.status}`);
  }
  const token = jLogin.content.tokenAccess;

  const u = new URL(`${BASE}/menuweb/menuextendido`);
  if (from) u.searchParams.set('fechaInicio', from);
  if (to)   u.searchParams.set('fechaFin', to);

  const rArt = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  const jArt = await rArt.json();
  if (jArt?.resultCode === 'SUCCESS') return jArt.content || [];
  throw new Error(`maxi_fetch_failed_${rArt.status}:${jArt?.resultDescription || ''}`);
}

exports.maxiArticles = async (req, res) => {
  const uid = req.user?.id;
  const businessId = req.businessId;
  const { from = '2025-01-01', to = '2025-04-01' } = req.query || {};
  if (!uid || !businessId) return res.status(400).json({ error: 'no_active_business' });

  const { rows } = await pool.query(`SELECT props FROM app_businesses WHERE id=$1`, [businessId]);
  const mx = (rows[0]?.props || {}).maxi || {};
  const password = mx.pass_enc ? decryptSecretCompat(mx.pass_enc) : mx.password;

  if (!(mx.email && password && mx.codcli)) return res.status(400).json({ error: 'maxi_not_configured' });

  try {
    const items = await callMaxiArticles({ email: mx.email, password, codcli: mx.codcli, from, to });
    res.json({ items });
  } catch (e) {
    console.error('GET /:id/maxi-articles error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
