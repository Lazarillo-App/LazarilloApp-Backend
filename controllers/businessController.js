// controllers/businessController.js
const pool = require('../config/db');
const { decryptSecretCompat, encryptSecret } = require('../utils/cryptoField');

const fetch = (...args) => globalThis.fetch(...args);

// ------------------- Helpers -------------------
const slugify = (s = '') =>
  String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function attachBranding(biz) {
  const br = (biz?.props && biz.props.branding) || biz.branding || {};
  return { ...biz, branding: { ...(biz.branding || {}), ...br } };
}

// ------------------- Negocios (CRUD + selección) -------------------
exports.listMine = async (req, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ error: 'unauthorized' });

    const { rows } = await pool.query(`
      SELECT DISTINCT b.id, b.name, b.slug, b.props, b.owner_id, b.created_at
      FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id = b.id
      WHERE (ub.user_id = $1 OR b.owner_id = $1)
      ORDER BY b.created_at ASC
    `, [uid]);

    res.json({ items: rows.map(attachBranding) });
  } catch (e) {
    console.error('GET /api/businesses error:', e);
    res.status(500).json({ error: 'internal' });
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
    const body = req.body || {};
    const businessId = body.businessId ?? body.activeBusinessId;   // ✅ acepta ambos
    if (!uid) return res.status(401).json({ error: 'unauthorized' });
    if (!businessId) return res.status(400).json({ error: 'businessId requerido' });

    const { rows: belongs } = await pool.query(`
      SELECT 1
        FROM app_businesses b
        LEFT JOIN user_businesses ub ON ub.business_id=b.id
       WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2)
       LIMIT 1
    `, [businessId, uid]);
    if (!belongs.length) return res.status(403).json({ error: 'forbidden' });

    await pool.query(`UPDATE app_users SET active_business_id=$1 WHERE id=$2`, [businessId, uid]);
    res.json({ ok: true, activeBusinessId: Number(businessId) });
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

    await pool.query(
      `INSERT INTO user_businesses (user_id, business_id, role)
   VALUES ($1,$2,'owner')
   ON CONFLICT (user_id, business_id) DO NOTHING`,
      [uid, biz.id]
    );

    await pool.query(`UPDATE app_users SET active_business_id=$1 WHERE id=$2`, [biz.id, uid]);

    return res.status(201).json({ ok: true, business: biz, activeBusinessId: biz.id });
  } catch (e) {
    console.error('POST /api/businesses error:', e);
    return res.status(500).json({ error: 'internal' });
  }
};

exports.update = async (req, res) => {
  const uid = req.user?.id;
  const businessId = req.businessId || Number(req.params.id) || req.business?.id;
  if (!uid) return res.status(401).json({ error: 'unauthorized' });
  if (!businessId) return res.status(404).json({ error: 'not_found' });

  const body = req.body || {};
  const name = body.name;

  const incomingBranding = (body.props && body.props.branding) || body.branding || {};
  const b = {
    primary:   incomingBranding.primary   ?? null,
    secondary: incomingBranding.secondary ?? null,
    background:incomingBranding.background?? null,
    font:      incomingBranding.font      ?? null,
    logo_url:  incomingBranding.logo_url  ?? null,
    fg:        incomingBranding.fg        ?? null,
  };

  const { rows } = await pool.query(`
    UPDATE app_businesses
       SET name = COALESCE($2, name),
           props =
             CASE
               WHEN $3::jsonb IS NULL THEN props
               ELSE COALESCE(props,'{}'::jsonb) ||
                    jsonb_build_object(
                      'branding',
                      COALESCE(props->'branding','{}'::jsonb) ||
                      jsonb_strip_nulls($3::jsonb)
                    )
             END,
           updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, slug, props, owner_id, created_at, updated_at
  `, [businessId, name ?? null, Object.values(b).every(v => v === null) ? null : b]);

  res.json({ business: attachBranding(rows[0]) });
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
         LEFT JOIN user_businesses ub ON ub.business_id = b.id
        WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id = $2)
        LIMIT 1`,
      [id, uid]
    );

    if (!belongs.length) {
      // return res.status(403).json({ error: 'forbidden' });
      return res.status(404).json({ error: 'not_found' }); // si preferís ocultar
    }

    await pool.query(
      `UPDATE app_users SET active_business_id = $1 WHERE id = $2`,
      [id, uid]
    );

    return res.json({ ok: true, activeBusinessId: id });
  } catch (e) {
    console.error('POST /api/businesses/:id/select error:', e);
    return res.status(500).json({ error: 'internal' });
  }
};


// controllers/businessController.js (solo el remove)
exports.remove = async (req, res) => {
  const uid = req.user?.id;             // setea authRequired (JWT)
  const bizId = Number(req.params?.id);   // viene de /businesses/:id

  if (!uid) return res.status(401).json({ error: 'unauthorized' });
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
  try {
    const uid   = req.user?.id;
    const bizId =
      Number(req.business?.id) ||
      Number(req.params?.id) ||
      Number(req.headers['x-business-id']);

    if (!uid) return res.status(401).json({ error: 'unauthorized' });
    if (!Number.isFinite(bizId)) return res.status(400).json({ error: 'invalid_business_id' });

    // validar acceso (owner o vínculo)
    const { rows: access } = await pool.query(`
      SELECT b.props
        FROM app_businesses b
        LEFT JOIN user_businesses ub ON ub.business_id=b.id AND ub.user_id=$2
       WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id IS NOT NULL)
       LIMIT 1`, [bizId, uid]);
    if (!access[0]) return res.status(404).json({ error: 'not_found' });

    const props = access[0].props || {};
    const mx = props.maxi || {};
    const configured = !!(mx.email && mx.codcli && (mx.pass_enc || mx.password));
    return res.json({ ok: true, business_id: bizId, configured, email: mx.email || null, codcli: mx.codcli || null });
  } catch (e) {
    console.error('GET /:id/maxi-status error:', e);
    return res.status(500).json({ error: 'internal' });
  }
};

// controllers/businessController.js

// controllers/businessController.js
exports.maxiSave = async (req, res) => {
  const uid = req.user?.id;
  const bizId = Number(req.params?.id);
  if (!uid) return res.status(401).json({ error: 'unauthorized' });
  if (!bizId || Number.isNaN(bizId)) return res.status(400).json({ error: 'invalid_business_id' });

  const { email, codcli } = req.body || {};
  const password = (req.body?.password ?? req.body?.pass)?.toString().trim(); // ✅

  const { rows: belongs } = await pool.query(
    `SELECT 1
       FROM app_businesses b
       LEFT JOIN user_businesses ub ON ub.business_id = b.id
      WHERE b.id = $1 AND (b.owner_id = $2 OR ub.user_id = $2)
      LIMIT 1`,
    [bizId, uid]
  );
  if (!belongs.length) return res.status(404).json({ error: 'not_found' });
  if (!email || !password || !codcli) return res.status(400).json({ error: 'missing_fields' });

  const maxi = { email: String(email).trim(), codcli: String(codcli).trim(), pass_enc: encryptSecret(password) };
  await pool.query(
    `UPDATE app_businesses
        SET props = jsonb_set(COALESCE(props,'{}'::jsonb), '{maxi}', $2::jsonb, true),
            updated_at = NOW()
      WHERE id = $1`,
    [bizId, maxi]
  );
  res.json({ ok: true, maxi: { email: maxi.email, codcli: maxi.codcli, configured: true } });
};

// ------------------- MAXI (helpers y proxy opcional) -------------------
async function callMaxiArticles({ email, password, codcli, from, to }) {
  const BASE = (process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar').replace(/\/+$/, '');

  const rLogin = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email, pass: password, cod_cli: String(codcli) })
  });
  const jLogin = await rLogin.json();
  if (!(jLogin?.resultCode === 'SUCCESS' && jLogin?.content?.tokenAccess)) {
    throw new Error(`maxi_login_failed_${rLogin.status}`);
  }
  const token = jLogin.content.tokenAccess;

  const u = new URL(`${BASE}/menuweb/menuextendido`);
  if (from) u.searchParams.set('fechaInicio', from);
  if (to) u.searchParams.set('fechaFin', to);

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

exports.getOne = async (req, res, next) => {
  try {
    if (!req.business) return res.status(404).json({ error: 'not_found' });
    res.json(attachBranding(req.business));
  } catch (e) { next(e); }
};

/* === subir archivo === */
exports.uploadLogo = async (req, res, next) => {
  try {
    const biz = req.business;
    if (!biz) return res.status(404).json({ error: 'not_found' });
    if (!req.file) return res.status(400).json({ error: 'missing_file' });

    // misma carpeta que sirve app.js
    const url = `/uploads/logos/${req.file.filename}`;

    await pool.query(`
      UPDATE app_businesses
         SET props = COALESCE(props,'{}'::jsonb) ||
                     jsonb_build_object(
                       'branding',
                       COALESCE(props->'branding','{}'::jsonb) ||
                       jsonb_build_object('logo_url', $2)
                     ),
             updated_at = NOW()
       WHERE id = $1
    `, [biz.id, url]);

    res.status(201).json({ ok: true, url });
  } catch (e) { next(e); }
};

/* === setear URL directa === */
exports.setBrandingUrl = async (req, res, next) => {
  try {
    const biz = req.business;
    if (!biz) return res.status(404).json({ error: 'not_found' });

    const { logo_url } = req.body || {};
    if (logo_url != null && typeof logo_url !== 'string') {
      return res.status(400).json({ error: 'invalid_logo_url' });
    }

    await pool.query(`
      UPDATE app_businesses
         SET props = COALESCE(props,'{}'::jsonb) ||
                     jsonb_build_object(
                       'branding',
                       COALESCE(props->'branding','{}'::jsonb) ||
                       jsonb_build_object('logo_url', $2)
                     ),
             updated_at = NOW()
       WHERE id = $1
    `, [biz.id, logo_url || null]);

    res.json({ ok: true, url: logo_url || null });
  } catch (e) { next(e); }
};