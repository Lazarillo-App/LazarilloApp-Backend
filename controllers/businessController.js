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


const slugify = (s='') =>
  String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);

exports.create = async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    const {
      name,
      branding = {},       // {primary,secondary,background,font}
      contact = {},        // {owner:{...}, manager:{...}, admin:{...}}
      address = {},        // {line1, city, country}
      social = {},         // {instagram, facebook, ...}
      lang = 'es-AR',
      currency = 'ARS',
      timezone = '-03:00',
      tax_id = ''
    } = req.body || {};

    if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });

    // slug único
    let base = slugify(name);
    if (!base) base = 'local';
    let slug = base, i = 1;
    // (búsqueda simple para evitar colisión)
    while (true) {
      const { rows } = await pool.query('SELECT 1 FROM app_businesses WHERE slug=$1 LIMIT 1', [slug]);
      if (!rows[0]) break;
      slug = `${base}-${++i}`;
    }

    const props = {
      branding, contact, address, social, lang, currency, timezone, tax_id
    };

    const { rows } = await pool.query(
      `INSERT INTO app_businesses (owner_id,name,slug,props)
       VALUES ($1,$2,$3,$4)
       RETURNING id, owner_id, name, slug, color_hex, props, created_at`,
      [uid, name.trim(), slug, props]
    );

    const biz = rows[0];

    // por comodidad: setear como activo
    await pool.query(`UPDATE app_users SET active_business_id=$1 WHERE id=$2`, [biz.id, uid]);

    res.status(201).json({ ok:true, business: biz, activeBusinessId: biz.id });
  } catch (e) {
    console.error('POST /api/businesses error:', e);
    res.status(500).json({ error: 'internal' });
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
    res.json({ ok:true, activeBusinessId:id });
  } catch (e) {
    console.error('POST /api/businesses/:id/select error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

const crypto = require('crypto');
const ENC_KEY = (process.env.ENCRYPTION_KEY || 'dev-key');
const KEY = crypto.createHash('sha256').update(ENC_KEY).digest(); // 32 bytes

function enc(plain='') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

exports.maxiStatus = async (req, res) => {
  try {
    const uid = req.user?.id;
    const id  = Number(req.params.id);
    if (!uid || !id) return res.status(400).json({ error: 'bad_request' });

    // validar pertenencia
    const { rows: ok } = await pool.query(`
      SELECT props FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id=b.id
      WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2) LIMIT 1
    `, [id, uid]);
    if (!ok[0]) return res.status(403).json({ error: 'forbidden' });

    const maxi = ok[0].props?.maxi || null;
    res.json({
      configured: !!(maxi?.email && maxi?.codcli && maxi?.passwordEnc),
      email: maxi?.email || null,
      codcli: maxi?.codcli || null
    });
  } catch (e) {
    console.error('GET /businesses/:id/maxi-status error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.maxiSave = async (req, res) => {
  try {
    const uid = req.user?.id;
    const id  = Number(req.params.id);
    const { email, password, codcli } = req.body || {};
    if (!uid || !id) return res.status(400).json({ error: 'bad_request' });
    if (!email || !password || !codcli) return res.status(400).json({ error: 'missing_fields' });

    // validar pertenencia
    const { rows: ok } = await pool.query(`
      SELECT 1 FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id=b.id
      WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2) LIMIT 1
    `, [id, uid]);
    if (!ok[0]) return res.status(403).json({ error: 'forbidden' });

    const maxi = {
      email,
      codcli,
      passwordEnc: enc(password), // 🔐 guardamos cifrado, nunca plano
      saved_at: new Date().toISOString()
    };

    await pool.query(`
      UPDATE app_businesses
      SET props = jsonb_set(COALESCE(props,'{}'::jsonb), '{maxi}', $2::jsonb, true),
          updated_at = NOW()
      WHERE id = $1
    `, [id, JSON.stringify(maxi)]);

    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('POST /businesses/:id/maxi-credentials error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
