// services/soporteService.js
// Chat de Anthony y pedidos de los clientes.
//  - 2026-11-10: menú guiado; el mensaje se guarda en soporte_mensajes y llega por mail al equipo.
//  - 2026-11-13 (usuaria): cada mensaje es un PEDIDO con captura de pantalla, tipo, estado, alcance
//    y un hilo de respuestas. Lo atienden los super usuarios desde su panel (no el /admin de
//    lazarillo.app2025). Aviso al instante por Telegram; el cliente ve las respuestas en el chat y
//    le llegan por mail.
'use strict';

const pool = require('../config/db');
const { sendEmail } = require('../utils/mailer');
const telegram = require('../utils/telegram');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_POR_HORA = 10;
const TIPOS = ['problema', 'pedido', 'consulta'];
const ESTADOS = ['nuevo', 'revision', 'contactar', 'desarrollo', 'resuelto', 'descartado'];
const ALCANCES = ['negocio', 'usuario', 'global'];
const CERRADOS = ['resuelto', 'descartado'];
const NOMBRE_ESTADO = {
  nuevo: 'Recibido', revision: 'En revisión', contactar: 'Te vamos a contactar',
  desarrollo: 'En desarrollo', resuelto: 'Resuelto', descartado: 'Cerrado',
};
const NOMBRE_TIPO = { problema: 'Problema', pedido: 'Pedido', consulta: 'Consulta' };

const FRONTEND_BASE_URL = (process.env.FRONTEND_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '');
const FRONTEND_BASE_PATH = (process.env.FRONTEND_BASE_PATH || '').replace(/\/+$/, '');
const urlFront = (p) => `${FRONTEND_BASE_URL}${FRONTEND_BASE_PATH}${p}`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const corto = (s, n) => String(s ?? '').trim().slice(0, n);

// ───────────────────────── configuración ─────────────────────────

async function leerConfig() {
  const { rows } = await pool.query('SELECT config FROM soporte_config WHERE id = 1');
  return rows[0]?.config || { emails: [], whatsapp: '', chat: { saludo: '', despedida: '', opciones: [] }, telegram: { chat_ids: [] } };
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
      // Anthony pide una captura de la pantalla antes del mensaje (13/11).
      ...(o.captura ? { captura: true } : {}),
      ...(TIPOS.includes(o.tipo) ? { tipo: o.tipo } : {}),
    };
  }).filter((o) => o.texto);
  if (!opciones.length) return { error: 'falta_una_opcion' };
  const chatIds = (Array.isArray(c.telegram?.chat_ids) ? c.telegram.chat_ids : [])
    .map((x) => String(x).trim()).filter((x) => /^-?\d{3,20}$/.test(x));
  return {
    config: {
      emails: [...new Set(emails)].slice(0, 10),
      whatsapp,
      chat: {
        saludo: corto(chat.saludo, 300) || '¡Hola! ¿En qué te puedo ayudar?',
        despedida: corto(chat.despedida, 300) || 'Listo, te vamos a contactar.',
        opciones,
      },
      telegram: { chat_ids: [...new Set(chatIds)].slice(0, 10) },
    },
  };
}

/** Lo que ve el usuario: el menú y el WhatsApp, nunca los mails ni los chats del equipo. */
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

// ───────────────────────── captura ─────────────────────────

// La captura llega como data URL (JPEG/PNG) y se guarda en Cloudinary. Sin Cloudinary, el pedido
// igual se guarda (sin imagen).
async function subirCaptura(dataUrl, userId) {
  const m = /^data:image\/(png|jpe?g|webp);base64,/i.exec(String(dataUrl || ''));
  if (!m) return null;
  if (dataUrl.length > 8 * 1024 * 1024) return null; // ~6 MB de imagen
  try {
    const cloudinary = require('../config/cloudinary');
    const r = await cloudinary.uploader.upload(dataUrl, {
      folder: 'lazarillo/pedidos', resource_type: 'image', public_id: `u${userId || 0}_${Date.now()}`,
    });
    return r?.secure_url || null;
  } catch (e) {
    console.error('[soporte] no se pudo subir la captura:', e?.message || e);
    return null;
  }
}

// ───────────────────────── avisos ─────────────────────────

async function avisarEquipoTelegram(config, html) {
  try { return await telegram.avisar(config.telegram?.chat_ids || [], html); }
  catch (e) { console.warn('[soporte] telegram:', e?.message); return { enviados: 0 }; }
}

// ───────────────────────── cliente ─────────────────────────

/** Crea el pedido, lo manda por mail al equipo y avisa por Telegram. */
async function enviarMensaje({ user, businessId, opcion, respuesta, mensaje, contexto, captura, tipo, pantalla }) {
  const texto = corto(mensaje, 4000);
  if (!texto) return { error: 'mensaje_vacio' };
  const { rows: cuenta } = await pool.query(
    `SELECT COUNT(*)::int n FROM soporte_mensajes WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [user?.id || null]);
  if (cuenta[0].n >= MAX_POR_HORA) return { error: 'demasiados_mensajes' };

  const config = await leerConfig();
  const op = (config.chat?.opciones || []).find((o) => o.id === opcion);
  const tipoFinal = TIPOS.includes(tipo) ? tipo : (op?.tipo || (opcion === 'tecnico' ? 'problema' : 'consulta'));
  const { rows: neg } = businessId
    ? await pool.query('SELECT id, name FROM app_businesses WHERE id = $1', [businessId])
    : { rows: [] };
  const capturaUrl = captura ? await subirCaptura(captura, user?.id) : null;
  const { rows: ins } = await pool.query(
    `INSERT INTO soporte_mensajes (user_id, business_id, opcion, respuesta, mensaje, contexto, tipo, captura_url, pantalla, visto_cliente_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now()) RETURNING id`,
    [user?.id || null, neg[0]?.id || null, corto(opcion, 30) || null, corto(respuesta, 300) || null, texto,
      contexto ? JSON.stringify(contexto) : null, tipoFinal, capturaUrl, corto(pantalla, 300) || null]);
  const id = ins[0].id;
  const linkPanel = urlFront(`/super?pedido=${id}`);

  const fila = (k, v) => (v ? `<tr><td style="padding:4px 10px;color:#666">${esc(k)}</td><td style="padding:4px 10px"><b>${esc(v)}</b></td></tr>` : '');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px">
    <h2 style="margin:0 0 10px">${esc(NOMBRE_TIPO[tipoFinal])} #${id} desde el chat de Anthony</h2>
    <table>${fila('Tema', op?.texto || opcion)}${fila('Respuesta', respuesta)}${fila('Usuario', user?.name || user?.email)}${fila('Email', user?.email)}${fila('Id', user?.id)}${fila('Negocio', neg[0] ? `${neg[0].name} (#${neg[0].id})` : '')}${fila('Pantalla', pantalla)}</table>
    <p style="white-space:pre-wrap;border-left:3px solid #2492C8;padding:8px 12px;background:#f5f8fb">${esc(texto)}</p>
    ${capturaUrl ? `<p><a href="${esc(capturaUrl)}"><img src="${esc(capturaUrl)}" alt="captura" style="max-width:520px;border:1px solid #ddd;border-radius:6px"></a></p>` : ''}
    <p><a href="${esc(linkPanel)}">Abrir en el panel de super usuarios</a></p></div>`;
  const r = await sendEmail(config.emails || [], `[Lazarillo] ${NOMBRE_TIPO[tipoFinal]} #${id}${neg[0] ? ` · ${neg[0].name}` : ''}`, html,
    { replyTo: user?.email && EMAIL_RE.test(user.email) ? user.email : undefined });
  const enviado = !r.error && (r.accepted || []).length > 0;
  await pool.query('UPDATE soporte_mensajes SET enviado = $2, error = $3 WHERE id = $1', [id, enviado, r.error || null]);

  const e = telegram.escHtml;
  await avisarEquipoTelegram(config,
    `🆕 <b>${e(NOMBRE_TIPO[tipoFinal])} #${id}</b>${neg[0] ? ` · ${e(neg[0].name)}` : ''}\n`
    + `${e(user?.name || user?.email || 'Usuario')}${user?.email ? ` · ${e(user.email)}` : ''}\n\n`
    + `«${e(texto.slice(0, 500))}${texto.length > 500 ? '…' : ''}»${capturaUrl ? '\n📷 con captura' : ''}\n\n${e(linkPanel)}`);
  return { ok: true, id, enviado, captura_url: capturaUrl };
}

/** Los pedidos del cliente con las respuestas que puede ver (sin notas internas). */
async function misPedidos(userId) {
  const { rows } = await pool.query(
    `SELECT m.id, m.created_at, m.tipo, m.estado, m.mensaje, m.captura_url, m.updated_at,
            b.name AS negocio,
            COALESCE((SELECT json_agg(json_build_object('id', r.id, 'texto', r.texto, 'de_equipo', r.de_equipo, 'created_at', r.created_at) ORDER BY r.created_at)
                        FROM soporte_respuestas r WHERE r.mensaje_id = m.id AND NOT r.interna), '[]') AS respuestas,
            (SELECT COUNT(*)::int FROM soporte_respuestas r
              WHERE r.mensaje_id = m.id AND r.de_equipo AND NOT r.interna
                AND r.created_at > COALESCE(m.visto_cliente_at, 'epoch')) AS sin_leer
       FROM soporte_mensajes m
       LEFT JOIN app_businesses b ON b.id = m.business_id
      WHERE m.user_id = $1
      ORDER BY m.created_at DESC LIMIT 30`, [userId]);
  return rows.map((p) => ({ ...p, estado_nombre: NOMBRE_ESTADO[p.estado] || p.estado }));
}

async function sinLeer(userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int n FROM soporte_respuestas r JOIN soporte_mensajes m ON m.id = r.mensaje_id
      WHERE m.user_id = $1 AND r.de_equipo AND NOT r.interna AND r.created_at > COALESCE(m.visto_cliente_at, 'epoch')`, [userId]);
  return rows[0].n;
}

async function marcarVistos(userId) {
  await pool.query('UPDATE soporte_mensajes SET visto_cliente_at = now() WHERE user_id = $1', [userId]);
}

/** El cliente contesta en su pedido: vuelve a "en revisión" si estaba cerrado y avisa al equipo. */
async function responderCliente(userId, pedidoId, textoRaw) {
  const texto = corto(textoRaw, 4000);
  if (!texto) return { error: 'mensaje_vacio' };
  const { rows } = await pool.query(
    `SELECT m.id, m.estado, u.email, coalesce(u.display_name, u.name, u.email) AS nombre, b.name AS negocio
       FROM soporte_mensajes m LEFT JOIN app_users u ON u.id = m.user_id LEFT JOIN app_businesses b ON b.id = m.business_id
      WHERE m.id = $1 AND m.user_id = $2`, [pedidoId, userId]);
  const p = rows[0];
  if (!p) return { error: 'no_encontrado', status: 404 };
  await pool.query(`INSERT INTO soporte_respuestas (mensaje_id, autor_id, de_equipo, texto) VALUES ($1, $2, false, $3)`, [p.id, userId, texto]);
  await pool.query(
    `UPDATE soporte_mensajes SET updated_at = now(), visto_cliente_at = now(),
            estado = CASE WHEN estado IN ('resuelto', 'descartado') THEN 'revision' ELSE estado END, cerrado_at = NULL
      WHERE id = $1`, [p.id]);
  const config = await leerConfig();
  const e = telegram.escHtml;
  await avisarEquipoTelegram(config,
    `💬 <b>Respuesta en el pedido #${p.id}</b>${p.negocio ? ` · ${e(p.negocio)}` : ''}\n${e(p.nombre)}\n\n«${e(texto.slice(0, 500))}»\n\n${e(urlFront(`/super?pedido=${p.id}`))}`);
  return { ok: true };
}

// ───────────────────────── equipo (super usuarios) ─────────────────────────

const SELECT_PEDIDO = `
  SELECT m.id, m.created_at, m.updated_at, m.cerrado_at, m.tipo, m.estado, m.alcance, m.asignado_a,
         m.opcion, m.respuesta, m.mensaje, m.captura_url, m.pantalla, m.contexto, m.enviado, m.error,
         m.user_id, u.email AS usuario_email, coalesce(u.display_name, u.name) AS usuario_nombre,
         m.business_id, b.name AS negocio, b.organization_id, o.name AS organizacion,
         a.email AS asignado_email, coalesce(a.display_name, a.name, a.email) AS asignado_nombre,
         (SELECT COUNT(*)::int FROM soporte_respuestas r WHERE r.mensaje_id = m.id) AS respuestas_n,
         (SELECT r.de_equipo FROM soporte_respuestas r WHERE r.mensaje_id = m.id AND NOT r.interna ORDER BY r.created_at DESC LIMIT 1) AS ultima_del_equipo
    FROM soporte_mensajes m
    LEFT JOIN app_users u ON u.id = m.user_id
    LEFT JOIN app_businesses b ON b.id = m.business_id
    LEFT JOIN organizations o ON o.id = b.organization_id
    LEFT JOIN app_users a ON a.id = m.asignado_a`;

async function listarPedidos({ estado, q, tipo } = {}) {
  const cond = [];
  const params = [];
  if (estado === 'abiertos') cond.push(`m.estado NOT IN ('resuelto', 'descartado')`);
  else if (ESTADOS.includes(estado)) { params.push(estado); cond.push(`m.estado = $${params.length}`); }
  if (TIPOS.includes(tipo)) { params.push(tipo); cond.push(`m.tipo = $${params.length}`); }
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim()}%`);
    const i = params.length;
    cond.push(`(m.mensaje ILIKE $${i} OR u.email ILIKE $${i} OR coalesce(u.name,'') ILIKE $${i} OR coalesce(b.name,'') ILIKE $${i} OR m.id::text = trim(both '%' from $${i}))`);
  }
  const { rows } = await pool.query(
    `${SELECT_PEDIDO} ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''} ORDER BY (m.estado = 'nuevo') DESC, m.updated_at DESC LIMIT 200`, params);
  const { rows: cuentas } = await pool.query(`SELECT estado, COUNT(*)::int n FROM soporte_mensajes GROUP BY estado`);
  return { pedidos: rows, cuentas: Object.fromEntries(cuentas.map((c) => [c.estado, c.n])) };
}

async function detallePedido(id) {
  const { rows } = await pool.query(`${SELECT_PEDIDO} WHERE m.id = $1`, [id]);
  const p = rows[0];
  if (!p) return null;
  const { rows: respuestas } = await pool.query(
    `SELECT r.id, r.texto, r.de_equipo, r.interna, r.created_at, coalesce(u.display_name, u.name, u.email) AS autor
       FROM soporte_respuestas r LEFT JOIN app_users u ON u.id = r.autor_id
      WHERE r.mensaje_id = $1 ORDER BY r.created_at`, [id]);
  // Negocios del cliente (para elegir a quién aplicar un ajuste).
  const { rows: negocios } = p.user_id ? await pool.query(
    `SELECT DISTINCT b.id, b.name, b.organization_id FROM app_businesses b
      WHERE b.owner_id = $1
         OR b.id IN (SELECT scope_id FROM user_assignments WHERE user_id = $1 AND scope_type = 'business' AND revoked_at IS NULL)
      ORDER BY b.name`, [p.user_id]).catch(() => ({ rows: [] })) : { rows: [] };
  const { rows: ajustes } = await pool.query('SELECT * FROM ajustes_alcance WHERE solicitud_id = $1 ORDER BY id', [id]);
  return { ...p, respuestas, negocios, ajustes };
}

async function actualizarPedido(id, cambios) {
  const sets = [];
  const params = [id];
  const poner = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (cambios.estado !== undefined) {
    if (!ESTADOS.includes(cambios.estado)) return { error: 'estado_invalido' };
    poner('estado', cambios.estado);
    sets.push(CERRADOS.includes(cambios.estado) ? 'cerrado_at = COALESCE(cerrado_at, now())' : 'cerrado_at = NULL');
  }
  if (cambios.tipo !== undefined) { if (!TIPOS.includes(cambios.tipo)) return { error: 'tipo_invalido' }; poner('tipo', cambios.tipo); }
  if (cambios.alcance !== undefined) {
    if (cambios.alcance !== null && !ALCANCES.includes(cambios.alcance)) return { error: 'alcance_invalido' };
    poner('alcance', cambios.alcance);
  }
  if (cambios.asignado_a !== undefined) poner('asignado_a', cambios.asignado_a ? Number(cambios.asignado_a) : null);
  if (!sets.length) return { error: 'nada_para_cambiar' };
  const { rowCount } = await pool.query(`UPDATE soporte_mensajes SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  if (!rowCount) return { error: 'no_encontrado', status: 404 };
  return { ok: true, pedido: await detallePedido(id) };
}

/** Respuesta del equipo: la ve el cliente en el chat y le llega por mail. Una nota interna no sale. */
async function responderEquipo(id, autorId, textoRaw, interna = false) {
  const texto = corto(textoRaw, 4000);
  if (!texto) return { error: 'mensaje_vacio' };
  const p = await detallePedido(id);
  if (!p) return { error: 'no_encontrado', status: 404 };
  await pool.query(`INSERT INTO soporte_respuestas (mensaje_id, autor_id, de_equipo, interna, texto) VALUES ($1, $2, true, $3, $4)`,
    [id, autorId, !!interna, texto]);
  // Al contestarle por primera vez, un pedido "nuevo" pasa a "en revisión".
  await pool.query(`UPDATE soporte_mensajes SET updated_at = now(), estado = CASE WHEN estado = 'nuevo' AND NOT $2 THEN 'revision' ELSE estado END WHERE id = $1`, [id, !!interna]);
  let mail = null;
  if (!interna && p.usuario_email && EMAIL_RE.test(p.usuario_email)) {
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px">
      <p>Hola${p.usuario_nombre ? ` ${esc(p.usuario_nombre)}` : ''}, el equipo de Lazarillo respondió tu ${esc((NOMBRE_TIPO[p.tipo] || 'pedido').toLowerCase())} #${id}:</p>
      <p style="white-space:pre-wrap;border-left:3px solid #2492C8;padding:8px 12px;background:#f5f8fb">${esc(texto)}</p>
      <p style="color:#666;font-size:13px">Lo que nos escribiste: «${esc(p.mensaje.slice(0, 300))}»</p>
      <p>Podés contestar desde el chat de Anthony en Lazarillo (<a href="${esc(urlFront('/'))}">entrar</a>).</p></div>`;
    const r = await sendEmail([p.usuario_email], `Lazarillo: respuesta a tu ${(NOMBRE_TIPO[p.tipo] || 'pedido').toLowerCase()} #${id}`, html);
    mail = !r.error && (r.accepted || []).length > 0;
  }
  return { ok: true, mail, pedido: await detallePedido(id) };
}

module.exports = {
  TIPOS, ESTADOS, ALCANCES, NOMBRE_ESTADO,
  leerConfig, validarConfig, chatPublico, guardarConfig,
  enviarMensaje, misPedidos, sinLeer, marcarVistos, responderCliente,
  listarPedidos, detallePedido, actualizarPedido, responderEquipo,
};
