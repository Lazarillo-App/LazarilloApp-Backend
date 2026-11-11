// controllers/completarNegocioController.js
//
// POST /api/places/completar — para el asistente de alta: cuando Google no
// trae logo, descripción o redes del local, los completa.
//   1) GRATIS (Diego, 08/11: "probemos con las opciones gratis primero"): lee la
//      web del local (meta descripción, logo, links a Instagram/Facebook/TikTok).
//   2) Si sigue faltando descripción: plantilla con el tipo y la ciudad de Google.
//   3) IA con búsqueda web (Claude + web_search) SOLO si COMPLETAR_CON_IA=1.
// El logo se baja en el servidor y vuelve como data URL (sin CORS en el navegador).
//
// body: { nombre, direccion?, ciudad?, web?, tipo?, falta?: ['logo','descripcion','instagram','facebook','tiktok','web'] }
// resp: { web, instagram, facebook, tiktok, descripcion, descripcionFuente: 'web'|'plantilla'|'ia'|'', logos: [dataUrl, ...] }

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';
const CAMPOS = ['logo', 'descripcion', 'instagram', 'facebook', 'tiktok', 'web'];
const SYSTEM_IA = `Sos el asistente de alta de Lazarillo (gestión gastronómica, Argentina). Buscás en la web datos OFICIALES de UN local puntual.
Reglas: solo cuentas y sitios de ESE local (mismo nombre y misma zona); si no estás seguro, dejá el campo vacío. No inventes.
Respondé SOLO un JSON: {"web":"","instagram":"","facebook":"","tiktok":"","descripcion":"","logos":[]}
- web/instagram/facebook/tiktok: URL completa del perfil oficial o "".
- descripcion: 1 o 2 oraciones en castellano rioplatense sobre qué es el local y qué ofrece (sin precios ni puntajes), o "".
- logos: hasta 3 URLs DIRECTAS de imagen (png/jpg/svg/webp) del logo oficial, o [].`;

function extractJSON(txt) {
  const t = String(txt || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(t); } catch { /* sigue */ }
  const i = t.indexOf('{'); const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch { /* nada */ } }
  return null;
}

// Páginas de plataformas (menús digitales, delivery, links): Google a veces las da como
// "sitio web" del local. Su ícono es el de la plataforma (ej. el de Waitry, usuaria 11/11),
// así que de ahí no se toman favicons; solo imágenes que no sean de la plataforma.
const PLATAFORMAS = ['waitry', 'fu.do', 'fudo', 'pedidosya', 'rappi', 'ubereats', 'linktr.ee', 'linkin.bio', 'beacons.ai',
  'instagram.com', 'facebook.com', 'wa.me', 'whatsapp', 'google.', 'goo.gl', 'maps.app', 'mercadopago', 'bit.ly',
  'tiktok.com', 'menu.club', 'cartadigital', 'meniu', 'tuucarta', 'menutech'];
function plataformaDe(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return ''; }
  return PLATAFORMAS.find((p) => host.includes(p)) || '';
}
// Archivo de imagen que es la marca de la plataforma (ej. ".../waitry-logo.png").
const esMarcaDePlataforma = (img, plataforma) => {
  if (!plataforma) return false;
  const clave = plataforma.split('.')[0];
  let archivo = '';
  try { archivo = new URL(img).pathname.split('/').pop().toLowerCase(); } catch { return false; }
  return archivo.includes(clave) || /favicon|apple-touch|android-chrome/.test(archivo);
};

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

// Lee la web del local (8 s, 1,5 MB) y saca lo que sirve, sin IA.
async function leerWeb(url) {
  const out = { descripcion: '', instagram: '', facebook: '', tiktok: '', logos: [] };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Lazarillo asistente de alta)', accept: 'text/html' } });
    if (!r.ok || !/text\/html/i.test(r.headers.get('content-type') || '')) return out;
    const html = (await r.text()).slice(0, 1_500_000);
    const base = r.url || url;
    const abs = (u) => { try { return new URL(u.replace(/&amp;/g, '&'), base).href; } catch { return ''; } };
    const attr = (tag, name) => { const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i')); return m ? m[1].trim() : ''; };
    const metas = html.match(/<meta\b[^>]*>/gi) || [];
    const meta = (k) => { for (const m of metas) { const n = (attr(m, 'name') || attr(m, 'property')).toLowerCase(); if (n === k) return attr(m, 'content'); } return ''; };
    const desc = meta('og:description') || meta('description');
    if (desc && desc.length >= 25) out.descripcion = desc.replace(/\s+/g, ' ').slice(0, 400);
    // Logos: apple-touch-icon / íconos grandes → <img> con "logo" → og:image.
    // En una página de plataforma (Waitry, Fudo…) los íconos son de la plataforma: se
    // saltean y primero va og:image, que suele ser la imagen del local.
    const plataforma = plataformaDe(base);
    const links = html.match(/<link\b[^>]*>/gi) || [];
    const og = meta('og:image');
    if (plataforma && og) out.logos.push(abs(og));
    if (!plataforma) {
      for (const l of links) { const rel = attr(l, 'rel').toLowerCase(); if (/apple-touch-icon|icon/.test(rel)) { const h = abs(attr(l, 'href')); if (h && !/\.ico(\?|$)/i.test(h)) out.logos.push(h); } }
    }
    for (const im of (html.match(/<img\b[^>]*>/gi) || [])) { if (/logo/i.test(im)) { const h = abs(attr(im, 'src') || attr(im, 'data-src')); if (h && !h.startsWith('data:')) out.logos.push(h); } }
    if (!plataforma && og) out.logos.push(abs(og));
    out.logos = out.logos.filter((h) => !esMarcaDePlataforma(h, plataforma));
    // Redes: primer link que no sea de "compartir"
    const hrefs = (html.match(/href\s*=\s*["'][^"']+["']/gi) || []).map((h) => h.replace(/^href\s*=\s*["']|["']$/gi, ''));
    const red = (re) => hrefs.find((h) => re.test(h) && !/sharer|share\?|intent|\/p\/|\/reel\/|\/posts?\//i.test(h)) || '';
    out.instagram = limpiaUrl(red(/instagram\.com\/[A-Za-z0-9._]+/i));
    out.facebook = limpiaUrl(red(/facebook\.com\/[A-Za-z0-9.\-]+/i));
    out.tiktok = limpiaUrl(red(/tiktok\.com\/@[A-Za-z0-9._]+/i));
    out.logos = [...new Set(out.logos.filter(Boolean))].slice(0, 6);
  } catch { /* web caída o lenta: seguimos sin nada */ } finally { clearTimeout(t); }
  return out;
}
exports._leerWeb = leerWeb;

async function buscarConIA({ nombre, direccion, ciudad, web, falta }) {
  const system = SYSTEM_IA;
  const user = `Local: ${String(nombre).trim()}${direccion ? `\nDirección: ${direccion}` : ''}${ciudad ? `\nCiudad: ${ciudad}` : ''}${web ? `\nWeb conocida: ${web}` : ''}\nDatos que faltan: ${falta.join(', ')}`;
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, messages: [{ role: 'user', content: user }], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }] }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    console.error('[places/completar] Anthropic error:', resp.status, detail.slice(0, 400));
    return null;
  }
  const data = await resp.json();
  return extractJSON((data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')) || null;
}

exports.completar = async (req, res) => {
  try {
    const { nombre, direccion = '', ciudad = '', web = '', tipo = '' } = req.body || {};
    if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'missing_nombre' });
    const falta = (Array.isArray(req.body?.falta) ? req.body.falta : CAMPOS).filter((k) => CAMPOS.includes(k));
    const out = { web: '', instagram: '', facebook: '', tiktok: '', descripcion: '', descripcionFuente: '', logos: [] };
    if (!falta.length) return res.json(out);
    const cands = [];

    // 1) La web del local (gratis)
    const webLocal = limpiaUrl(web);
    // Si el "sitio web" que dio Google es el Instagram o el Facebook del local, es su red.
    if (/instagram\.com/i.test(webLocal) && handleDe(webLocal, 'instagram')) out.instagram = webLocal;
    if (/facebook\.com/i.test(webLocal) && handleDe(webLocal, 'facebook')) out.facebook = webLocal;
    if (webLocal) {
      const w = await leerWeb(webLocal);
      if (falta.includes('descripcion') && w.descripcion) { out.descripcion = w.descripcion; out.descripcionFuente = 'web'; }
      for (const k of ['instagram', 'facebook', 'tiktok']) if (falta.includes(k) && !out[k]) out[k] = w[k];
      cands.push(...w.logos);
    }

    // 2) IA con búsqueda web, solo si está prendida y sigue faltando algo
    const sigueFaltando = falta.filter((k) => (k === 'logo' ? false : !out[k]));
    if (process.env.COMPLETAR_CON_IA === '1' && process.env.ANTHROPIC_API_KEY && sigueFaltando.length) {
      const j = await buscarConIA({ nombre, direccion, ciudad, web: webLocal, falta: [...sigueFaltando, ...(falta.includes('logo') ? ['logo'] : [])] });
      if (j) {
        for (const k of ['web', 'instagram', 'facebook', 'tiktok']) if (falta.includes(k) && !out[k]) out[k] = limpiaUrl(j[k]);
        if (falta.includes('descripcion') && !out.descripcion && typeof j.descripcion === 'string' && j.descripcion.trim()) { out.descripcion = j.descripcion.trim().slice(0, 600); out.descripcionFuente = 'ia'; }
        for (const u of (Array.isArray(j.logos) ? j.logos : [])) { const c = limpiaUrl(u); if (c) cands.push(c); }
      }
    }

    // 3) Descripción sugerida con lo que dio Google (tipo + ciudad)
    if (falta.includes('descripcion') && !out.descripcion && tipo) {
      out.descripcion = `${String(tipo).trim()}${ciudad ? ` en ${String(ciudad).trim()}` : ''}.`;
      out.descripcionFuente = 'plantilla';
    }

    // Logo: lo encontrado + fotos de perfil de las redes + favicon grande de la web
    if (falta.includes('logo')) {
      const ig = handleDe(out.instagram, 'instagram');
      const fb = handleDe(out.facebook, 'facebook');
      if (fb) cands.push(`https://graph.facebook.com/${fb}/picture?type=large`);
      if (ig) cands.push(`https://unavatar.io/instagram/${ig}?fallback=false`);
      // Favicon solo de una web propia: el de una plataforma es su marca, no la del local.
      const w2 = [out.web, webLocal].find((u) => u && !plataformaDe(u)) || '';
      let dom = ''; try { dom = new URL(w2).hostname.replace(/^www\./, ''); } catch { /* sin web */ }
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
exports._plataformaDe = plataformaDe;
exports.bajarImagen = bajarImagen;
