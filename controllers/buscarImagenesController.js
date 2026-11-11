// controllers/buscarImagenesController.js
//
// Búsqueda de imágenes para encontrar el logo de un local sin web (usuaria 11/11:
// "si busco en imágenes sí sale"). Usa la API de Brave Search (la de Google se
// cierra el 1/1/2027 y no acepta clientes nuevos). La key vive solo acá
// (env BRAVE_SEARCH_API_KEY). Sin key, responde 501 y el asistente esconde la opción.
//
// GET /api/places/imagenes?q=...      → { imagenes: [{ thumb, fuente, titulo }] }
// GET /api/places/imagen?url=<thumb>  → { dataUrl }  (baja la elegida, solo miniaturas de Brave)

const { bajarImagen } = require('./completarNegocioController');

const BRAVE_URL = 'https://api.search.brave.com/res/v1/images/search';
// Solo se bajan miniaturas servidas por Brave: el back no hace de proxy de cualquier URL.
const HOST_MINIATURAS = /^imgs\.search\.brave\.com$/i;

exports.buscar = async (req, res) => {
  try {
    if (!process.env.BRAVE_SEARCH_API_KEY) return res.status(501).json({ error: 'imagenes_no_configurado' });
    const q = String(req.query.q || '').trim().slice(0, 120);
    if (!q) return res.status(400).json({ error: 'missing_query' });

    const params = new URLSearchParams({ q, count: '12', country: 'AR', search_lang: 'es', safesearch: 'strict' });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    let resp;
    try {
      resp = await fetch(`${BRAVE_URL}?${params}`, {
        signal: ctrl.signal,
        headers: { accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY },
      });
    } finally { clearTimeout(t); }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error('[places/imagenes] Brave error:', resp.status, detail.slice(0, 300));
      return res.status(502).json({ error: 'imagenes_upstream_error' });
    }
    const data = await resp.json();
    const imagenes = (data.results || [])
      .map((r) => ({
        thumb: r?.thumbnail?.src || '',
        fuente: r?.meta_url?.hostname || r?.source || '',
        titulo: String(r?.title || '').slice(0, 120),
      }))
      .filter((r) => {
        try { return HOST_MINIATURAS.test(new URL(r.thumb).hostname); } catch { return false; }
      });
    res.json({ imagenes });
  } catch (e) {
    console.error('[places/imagenes] error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

exports.bajar = async (req, res) => {
  try {
    const url = String(req.query.url || '');
    let host = '';
    try { const u = new URL(url); if (u.protocol !== 'https:') throw new Error('no https'); host = u.hostname; } catch { return res.status(400).json({ error: 'url_invalida' }); }
    if (!HOST_MINIATURAS.test(host)) return res.status(400).json({ error: 'url_no_permitida' });
    const dataUrl = await bajarImagen(url);
    if (!dataUrl) return res.status(502).json({ error: 'no_se_pudo_bajar' });
    res.json({ dataUrl });
  } catch (e) {
    console.error('[places/imagen] error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
