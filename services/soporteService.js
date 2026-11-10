// services/soporteService.js
// Chat de Anthony "Que lo haga Lazarillo" (2026-11-10). La configuración (mails que reciben,
// WhatsApp, menú y respuestas de Anthony) vive en soporte_config para editarla desde el panel de
// super-admin; los mensajes quedan en soporte_mensajes y se mandan por mail al equipo.
'use strict';

const pool = require('../config/db');
const { sendEmail } = require('../utils/mailer');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_POR_HORA = 10;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const corto = (s, n) => String(s ?? '').trim().slice(0, n);

async function leerConfig() {
  const { rows } = await pool.query('SELECT config FROM soporte_config WHERE id = 1');
  return rows[0]?.config || { emails: [], whatsapp: '', chat: { saludo: '', despedida: '', opciones: [] } };
}

/** Valida y limpia una configuración. Devuelve { config } o { error }. */
function validarConfig(c) {
  if (!c || typeof c !== 'object') return { error: 'config_invalida' };
  const emails = (Array.isArray(c.emails) ? c.emails : []).map((e) => String(e).trim()).filter(Boolean);
  if (!emails.length) return { error: 'falta_un_mail' };
  const malo = emails.find((e) => !EMAIL_RE.test(e));
  if (malo) return { error: `mail_invalido: ${malo}` };
  const whatsapp = String(c.whatsapp ?? '').replace(/\D/g, '');
  const chat = c.chat || {};
  const opciones = (Array.isArray(chat.opciones) ? chat.opciones : []).map((o, i) => {
    const pregunta = o.pregunta && corto(o.pregunta.texto, 200)
      ? {
        texto: corto(o.pregunta.texto, 200),
        ...(o.pregunta.libre ? { libre: true } : {}),
        ...(Array.isArray(o.pregunta.opciones) ? { opciones: o.pregunta.opciones.map((x) => corto(x, 80)).filter(Boolean).slice(0, 12) } : {}),
      }
      : null;
    return {
      id: corto(o.id, 30) || `op${i + 1}`,
      texto: corto(o.texto, 120),
      ...(pregunta ? { pregunta } : {}),
      pedido: corto(o.pedido, 300) || 'Escribinos tu mensaje.',
    };
  }).filter((o) => o.texto);
  if (!opciones.length) return { error: 'falta_una_opcion' };
  return {
    config: {
      emails: [...new Set(emails)].slice(0, 10),
      whatsapp,
      chat: {
        saludo: corto(chat.saludo, 300) || '¡Hola! ¿En qué te puedo ayudar?',
        despedida: corto(chat.despedida, 300) || 'Listo, te vamos a contactar.',
        opciones,
      },
    },
  };
}

/** Lo que ve el usuario: el menú y el WhatsApp, nunca los mails del equipo. */
async function chatPublico() {
  const c = await leerConfig();
  return { chat: c.chat, whatsapp: c.whatsapp || null };
}

async function guardarConfig(config, userId) {
  const v = validarConfig(config);
  if (v.error) return v;
  await pool.query(
    `INSERT INTO soporte_config (id, config, updated_at, updated_by) VALUES (1, $1::jsonb, now(), $2)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(v.config), userId || null]);
  return { config: v.config };
}

/** Guarda el mensaje y lo manda por mail al equipo. */
async function enviarMensaje({ user, businessId, opcion, respuesta, mensaje, contexto }) {
  const texto = corto(mensaje, 4000);
  if (!texto) return { error: 'mensaje_vacio' };
  const { rows: cuenta } = await pool.query(
    `SELECT COUNT(*)::int n FROM soporte_mensajes WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [user?.id || null]);
  if (cuenta[0].n >= MAX_POR_HORA) return { error: 'demasiados_mensajes' };

  const config = await leerConfig();
  const op = (config.chat?.opciones || []).find((o) => o.id === opcion);
  const { rows: neg } = businessId
    ? await pool.query('SELECT id, name FROM app_businesses WHERE id = $1', [businessId])
    : { rows: [] };
  const { rows: ins } = await pool.query(
    `INSERT INTO soporte_mensajes (user_id, business_id, opcion, respuesta, mensaje, contexto)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [user?.id || null, neg[0]?.id || null, corto(opcion, 30) || null, corto(respuesta, 300) || null, texto, contexto ? JSON.stringify(contexto) : null]);
  const id = ins[0].id;

  const fila = (k, v) => (v ? `<tr><td style="padding:4px 10px;color:#666">${esc(k)}</td><td style="padding:4px 10px"><b>${esc(v)}</b></td></tr>` : '');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px">
    <h2 style="margin:0 0 10px">Mensaje desde el chat de Anthony</h2>
    <table>${fila('Tema', op?.texto || opcion)}${fila('Respuesta', respuesta)}${fila('Usuario', user?.name || user?.email)}${fila('Email', user?.email)}${fila('Negocio', neg[0] ? `${neg[0].name} (#${neg[0].id})` : '')}</table>
    <p style="white-space:pre-wrap;border-left:3px solid #2492C8;padding:8px 12px;background:#f5f8fb">${esc(texto)}</p>
    <p style="color:#888;font-size:12px">Mensaje #${id}. Respondé este mail para contestarle directo.</p></div>`;
  const r = await sendEmail(config.emails || [], `[Lazarillo] ${op?.texto || 'Mensaje'}${neg[0] ? ` · ${neg[0].name}` : ''}`, html,
    { replyTo: user?.email && EMAIL_RE.test(user.email) ? user.email : undefined });
  const enviado = !r.error && (r.accepted || []).length > 0;
  await pool.query('UPDATE soporte_mensajes SET enviado = $2, error = $3 WHERE id = $1', [id, enviado, r.error || null]);
  return { ok: true, id, enviado };
}

module.exports = { leerConfig, validarConfig, chatPublico, guardarConfig, enviarMensaje };
