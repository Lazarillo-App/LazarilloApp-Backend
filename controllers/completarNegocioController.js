// controllers/completarNegocioController.js
//
// POST /api/places/completar — para el asistente de alta: cuando Google no
// trae logo, descripción o redes del local, los busca en la web con Claude
// (tool web_search) y resuelve el logo del lado del servidor (lo baja y lo
// devuelve como data URL, así el navegador no choca con CORS).
//
// body: { nombre, direccion?, ciudad?, web?, falta?: ['logo','descripcion','instagram','facebook','tiktok','web'] }
// resp: { web, instagram, facebook, tiktok, descripcion, logos: [dataUrl, ...] }

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';
const CAMPOS = ['logo', 'descripcion', 'instagram', 'facebook', 'tiktok', 'web'];

function extractJSON(txt) {
  const t = String(txt || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(t); } catch { /* sigue */ }
  const i = t.indexOf('{'); const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch { /* nada */ } }
  return null;
}

const limpiaUrl = (u) => {
  const s = String(u || '').trim();
  return /^https?:\/\/[^\s"']+$/i.test(s) ? s : '';
};
// "https://instagram.com/foo/" | "@foo" | "foo" → "foo"
function handleDe(u, dominio) {
  const s = String(u || '').trim();
  if (!s) return '';
  const m = s.match(new RegExp(`${dominio}\\.com/(?:@)?([A-Za-z0-9._-]+)`, 'i'));
  if (m) return m[1];
  if (/^@?[A-Za-z0-9._-]{2,}$/.test(s)) return s.replace(/^@/, '');
  return '';
}

// Baja una imagen y la devuelve como data URL (o null). Tope 3 MB, 6 s.
async function bajarImagen(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Lazarillo asistente de alta)' } });
    if (!r.ok) return null;
    const tipo = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//.test(tipo)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1200 || buf.length > 3 * 1024 * 1024) return null; // descarta íconos vacíos/gigantes
    return `data:${tipo};base64,${buf.toString('base64')}`;
  } catch { return null; } finally { clearTimeout(t); }
}

exports.completar = async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('[places/completar] falta ANTHROPIC_API_KEY');
      return res.status(500).json({ error: 'ai_not_configured' });
    }
    const { nombre, direccion = '', ciudad = '', web = '' } = req.body || {};
    if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'missing_nombre' });
    const falta = (Array.isArray(req.body?.falta) ? req.body.falta : CAMPOS).filter((k) => CAMPOS.includes(k));
    if (!falta.length) return res.json({ logos: [] });

    const system = `Sos el asistente de alta de Lazarillo (gestión gastronómica, Argentina). Buscás en la web datos OFICIALES de UN local puntual.
Reglas: solo cuentas y sitios de ESE local (mismo nombre y misma zona); si no estás seguro, dejá el campo vacío. No inventes.
Respondé SOLO un JSON: {"web":"","instagram":"","facebook":"","tiktok":"","descripcion":"","logos":[]}
- web/instagram/facebook/tiktok: URL completa del perfil oficial o "".
- descripcion: 1 o 2 oraciones en castellano rioplatense sobre qué es el local y qué ofrece (sin precios ni puntajes), o "".
- logos: hasta 3 URLs DIRECTAS de imagen (png/jpg/svg/webp) del logo oficial, o [].`;
    const user = `Local: ${String(nombre).trim()}${direccion ? `\nDirección: ${direccion}` : ''}${ciudad ? `\nCiudad: ${ciudad}` : ''}${web ? `\nWeb conocida: ${web}` : ''}\nDatos que faltan: ${falta.join(', ')}`;

    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1200, system,
        messages: [{ role: 'user', content: user }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error('[places/completar] Anthropic error:', resp.status, detail.slice(0, 400));
      return res.status(502).json({ error: 'ai_upstream_error' });
    }
    const data = await resp.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const j = extractJSON(text) || {};

    const out = {
      web: limpiaUrl(j.web),
      instagram: limpiaUrl(j.instagram),
      facebook: limpiaUrl(j.facebook),
      tiktok: limpiaUrl(j.tiktok),
      descripcion: typeof j.descripcion === 'string' ? j.descripcion.trim().slice(0, 600) : '',
      logos: [],
    };

    if (falta.includes('logo')) {
      const cands = [];
      for (const u of (Array.isArray(j.logos) ? j.logos : [])) { const c = limpiaUrl(u); if (c) cands.push(c); }
      const ig = handleDe(out.instagram, 'instagram');
      const fb = handleDe(out.facebook, 'facebook');
      if (fb) cands.push(`https://graph.facebook.com/${fb}/picture?type=large`);
      if (ig) cands.push(`https://unavatar.io/instagram/${ig}?fallback=false`);
      if (fb) cands.push(`https://unavatar.io/facebook/${fb}?fallback=false`);
      const webLocal = out.web || limpiaUrl(web);
      let dom = ''; try { dom = new URL(webLocal).hostname.replace(/^www\./, ''); } catch { /* sin web */ }
      if (dom) cands.push(`https://www.google.com/s2/favicons?domain=${dom}&sz=256`);
      const unicos = [...new Set(cands)].slice(0, 8);
      const imgs = await Promise.all(unicos.map(bajarImagen));
      out.logos = [...new Set(imgs.filter(Boolean))].slice(0, 4);
    }
    res.json(out);
  } catch (e) {
    console.error('[places/completar] error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
exports._handleDe = handleDe;
