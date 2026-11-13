// utils/telegram.js
// Avisos al Telegram del equipo (usuaria 13/11/2026: "ese bot solo me avisa"). El bot no lee ni
// responde nada: solo manda. El token vive en la env TELEGRAM_BOT_TOKEN (Render); los chats que
// reciben se guardan en soporte_config.config.telegram.chat_ids desde el panel de super usuarios.
'use strict';

const API = 'https://api.telegram.org';
const token = () => String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const configurado = () => !!token();

async function llamar(metodo, body, timeoutMs = 8000) {
  if (!configurado()) return { ok: false, error: 'telegram_sin_token' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}/bot${token()}/${metodo}`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, error: j.description || `HTTP ${r.status}` };
    return { ok: true, result: j.result };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)) };
  } finally { clearTimeout(t); }
}

const escHtml = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Manda un texto (HTML de Telegram) a cada chat. Nunca tira: devuelve cuántos salieron. */
async function avisar(chatIds, html) {
  const ids = [...new Set((chatIds || []).map((x) => String(x).trim()).filter(Boolean))];
  if (!configurado() || !ids.length) return { enviados: 0, error: !configurado() ? 'telegram_sin_token' : 'sin_chats' };
  let enviados = 0;
  let error = null;
  for (const chat_id of ids) {
    const r = await llamar('sendMessage', { chat_id, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
    if (r.ok) enviados += 1; else { error = r.error; console.warn('[telegram] no salió a', chat_id, r.error); }
  }
  return { enviados, error };
}

/**
 * Chats que le escribieron al bot hace poco (para "Detectar mi chat" en el panel: la persona le
 * manda /start al bot y acá aparece su chat_id). Devuelve [{ id, nombre }].
 */
async function chatsRecientes() {
  const r = await llamar('getUpdates', { limit: 50, allowed_updates: ['message'] });
  if (!r.ok) return { error: r.error };
  const vistos = new Map();
  for (const u of r.result || []) {
    const c = u.message?.chat;
    if (!c?.id) continue;
    const nombre = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || c.username || String(c.id);
    vistos.set(String(c.id), { id: String(c.id), nombre: c.username ? `${nombre} (@${c.username})` : nombre });
  }
  return { chats: [...vistos.values()] };
}

module.exports = { configurado, avisar, chatsRecientes, escHtml };
