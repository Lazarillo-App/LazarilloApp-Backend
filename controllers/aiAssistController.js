// controllers/aiAssistController.js
//
// Proxy único hacia la API de Anthropic para el asistente de onboarding
// (src/componentes/asistente/AsistenteOnboarding.jsx en el frontend). La key
// vive solo acá (env ANTHROPIC_API_KEY), nunca en el browser.
//
// Contrato (ya implementado tal cual en el frontend, este endpoint solo tiene
// que cumplirlo):
//   POST /api/ai/assist
//   body: { system, user?, content?, json?: boolean, websearch?: boolean }
//     - user: texto plano (charla, clasificación, generación de recetas).
//     - content: array de bloques nativos de la API de Anthropic (para
//       extracción de PDF/foto: [{type:'image'|'document', source:{...}},
//       {type:'text', text:'...'}]) — se pasa tal cual como contenido del
//       mensaje de usuario.
//     - json: si es true, se reafirma al modelo que responda solo JSON.
//     - websearch: si es true, se habilita la tool web_search de Anthropic
//       (usada para buscar el negocio, geocodificar una zona, y buscar logos).
//   response: { text: string, json?: any }
//     - text: el texto de la respuesta (bloques type:'text' concatenados).
//     - json: si json:true y se pudo parsear, el objeto/array ya parseado
//       (el frontend igual tiene su propio fallback de extracción por si no
//       viene, así que esto es una comodidad, no un requisito).

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Solo la búsqueda de negocio (websearch:true) necesita el modelo grande —
// tiene que juzgar resultados ambiguos de la web real. Todo lo demás (leer un
// PDF/foto, clasificar rubros en lotes, generar una receta) es una tarea
// mecánica y acotada: Haiku 4.5 alcanza de sobra y sale mucho más barato.
const MODEL_WEBSEARCH = 'claude-sonnet-5';
const MODEL_DEFAULT = 'claude-haiku-4-5-20251001';

// Mismo extractor "tolerante" que ya usa el frontend (busca el primer {..}/[..]
// balanceado en el texto, por si el modelo agrega texto alrededor del JSON).
function extractJSON(txt) {
  const t = String(txt || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  const direct = tryParse(t);
  if (direct !== undefined) return direct;

  const close = { '{': '}', '[': ']' };
  for (let i = 0; i < t.length; i++) {
    const o = t[i];
    if (o !== '{' && o !== '[') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < t.length; j++) {
      const ch = t[j];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === o) depth++;
      else if (ch === close[o]) {
        depth--;
        if (depth === 0) {
          const p = tryParse(t.slice(i, j + 1));
          if (p !== undefined) return p;
          break;
        }
      }
    }
  }
  return null;
}

exports.assist = async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('[ai/assist] falta ANTHROPIC_API_KEY');
      return res.status(500).json({ error: 'ai_not_configured' });
    }

    const { system, user, content, json, websearch } = req.body || {};
    if (!system || (user == null && content == null)) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    const messageContent = content != null ? content : user;
    const effectiveSystem = json
      ? `${system}\n\nRespondé SIEMPRE con JSON válido (sin texto extra, sin markdown, sin \`\`\`).`
      : system;

    const body = {
      model: websearch ? MODEL_WEBSEARCH : MODEL_DEFAULT,
      // Topes ajustados por tipo de tarea, no un único valor genérico:
      // - websearch: hasta 8 negocios con datos cortos.
      // - extracción de PDF/foto (content): una carta/lista por archivo.
      // - texto plano (clasificación en lotes de ~35, receta de hasta 9 insumos, etc.)
      max_tokens: websearch ? 1500 : (Array.isArray(content) ? 1200 : 2048),
      system: effectiveSystem,
      messages: [{ role: 'user', content: messageContent }],
    };
    if (websearch) {
      body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    }

    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error('[ai/assist] Anthropic error:', resp.status, detail.slice(0, 500));
      // 429/5xx: el frontend (callClaude) ya sabe reintentar solo con estos códigos.
      return res.status(resp.status === 429 || resp.status >= 500 ? resp.status : 502)
        .json({ error: 'ai_upstream_error' });
    }

    const data = await resp.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    const out = { text };
    if (json) {
      const parsed = extractJSON(text);
      if (parsed != null) out.json = parsed;
    }
    res.json(out);
  } catch (e) {
    console.error('[ai/assist] error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
