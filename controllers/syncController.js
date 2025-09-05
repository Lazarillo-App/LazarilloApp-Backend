// controllers/syncController.js
const pool = require('../config/db');
const crypto = require('crypto');

const ENC_KEY = (process.env.ENCRYPTION_KEY || 'dev-key-dev-key-dev-key-32!!').slice(0,32);
const ENC_IV  = Buffer.from('00000000000000000000000000000000'.slice(0,32), 'hex');
function dec(h=''){ try{ const d=crypto.createDecipheriv('aes-256-ctr', Buffer.from(ENC_KEY), ENC_IV); return Buffer.concat([d.update(Buffer.from(h,'hex')), d.final()]).toString('utf8'); }catch{return '';} }

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maxi_articles (
      business_id INT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
      articulo_id BIGINT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, articulo_id)
    );
    CREATE INDEX IF NOT EXISTS maxi_articles_biz_updated_idx ON maxi_articles (business_id, updated_at DESC);
  `);
}

// Reutilizamos tu callMaxiArticles del businessController (copio un esqueleto)
async function callMaxiArticles({ email, password, codcli, from, to }) {
  const BASE = process.env.MAXI_BASE_URL;
  // 1) login
  const tRes = await fetch(`${BASE}/auth/login`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ username: email, password })
  });
  if (!tRes.ok) throw new Error('maxi_login_failed');
  const { token } = await tRes.json();

  // 2) artículos (ajusta ruta/params a tu API real)
  const aRes = await fetch(`${BASE}/articulos?codcli=${encodeURIComponent(codcli)}&desde=${from}&hasta=${to}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!aRes.ok) throw new Error('maxi_fetch_failed');
  const items = await aRes.json();
  return Array.isArray(items) ? items : (items?.data || []);
}

// POST /api/businesses/:id/sync  body: { scope?: 'articles'|'sales'|'all', from?, to? }
exports.syncNow = async (req, res) => {
  const uid = req.user?.id;
  const id = Number(req.params.id);
  const { scope = 'articles', from = '2025-01-01', to = '2025-12-31' } = req.body || {};
  if (!uid || !id) return res.status(400).json({ error:'bad_request' });

  try {
    // pertenencia + props
    const { rows } = await pool.query(`
      SELECT props FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id=b.id
      WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2) LIMIT 1
    `, [id, uid]);
    if (!rows[0]) return res.status(403).json({ error:'forbidden' });

    const props = rows[0].props || {};
    const mx = props.maxi || {};
    const password = mx.pass_enc ? dec(mx.pass_enc) : mx.password;
    if (!(mx.email && password && mx.codcli)) {
      return res.status(400).json({ error:'maxi_not_configured' });
    }

    await ensureTables();

    const out = { ok:true, scope, saved:0 };
    if (scope === 'articles' || scope === 'all') {
      const items = await callMaxiArticles({ email: mx.email, password, codcli: mx.codcli, from, to });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const raw of items) {
          const articuloId =
            Number(raw?.id ?? raw?.articuloId ?? raw?.codigo ?? raw?.codigoArticulo);
          if (!Number.isFinite(articuloId) || articuloId <= 0) continue;

          await client.query(
            `INSERT INTO maxi_articles (business_id, articulo_id, data, updated_at)
             VALUES ($1,$2,$3::jsonb,NOW())
             ON CONFLICT (business_id, articulo_id)
             DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`,
            [id, articuloId, JSON.stringify(raw)]
          );
          out.saved++;
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

    // (si más adelante agregás ventas, manejá aquí 'sales' o 'all')

    return res.json(out);
  } catch (e) {
    console.error('POST /businesses/:id/sync error:', e);
    return res.status(500).json({ error:'internal' });
  }
};

// GET /api/businesses/:id/articles  (desde BD, rápido)
exports.listArticlesFromDB = async (req, res) => {
  const uid = req.user?.id;
  const id = Number(req.params.id);
  if (!uid || !id) return res.status(400).json({ error:'bad_request' });

  try {
    // pertenencia
    const { rows: ok } = await pool.query(`
      SELECT 1 FROM app_businesses b
      LEFT JOIN user_businesses ub ON ub.business_id=b.id
      WHERE b.id=$1 AND (b.owner_id=$2 OR ub.user_id=$2) LIMIT 1
    `, [id, uid]);
    if (!ok.length) return res.status(403).json({ error:'forbidden' });

    const { rows } = await pool.query(
      `SELECT articulo_id, data FROM maxi_articles WHERE business_id=$1 ORDER BY articulo_id ASC`,
      [id]
    );

    // devolvemos una forma “normalizada”
    const items = rows.map(r => {
      const a = r.data || {};
      const id = Number(a?.id ?? a?.articuloId ?? a?.codigo ?? a?.codigoArticulo ?? r.articulo_id);
      return {
        id,
        nombre: a.nombre ?? a.descripcion ?? '',
        precio: Number(a.precio ?? a.price ?? 0),
        costo: Number(a.costo ?? a.cost ?? 0),
        categoria: a.categoria ?? a.rubro ?? 'Sin categoría',
        subrubro: a.subrubro ?? 'Sin subrubro',
        raw: a, // por si el front necesita más
      };
    });

    return res.json({ items });
  } catch (e) {
    console.error('GET /businesses/:id/articles error:', e);
    return res.status(500).json({ error:'internal' });
  }
};
