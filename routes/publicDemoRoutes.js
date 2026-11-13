// routes/publicDemoRoutes.js
// Monta en: app.use('/api/public/demo', publicDemoRoutes) — SIN auth.
// Pedido de demo desde la landing: se guarda en demo_requests y se avisa por mail a los asesores
// (lista en config/demoDestinos.js).
'use strict';

const router = require('express').Router();
const pool = require('../config/db');
const { sendEmail } = require('../utils/mailer');
const DESTINOS = require('../config/demoDestinos');

// Freno simple contra abuso: hasta 5 pedidos por IP por hora (en memoria).
const VENTANA_MS = 60 * 60 * 1000;
const MAX_POR_IP = 5;
const porIp = new Map();
function permitido(ip) {
  const ahora = Date.now();
  const lista = (porIp.get(ip) || []).filter((t) => ahora - t < VENTANA_MS);
  if (lista.length >= MAX_POR_IP) { porIp.set(ip, lista); return false; }
  lista.push(ahora);
  porIp.set(ip, lista);
  return true;
}

const limpio = (v, max) => String(v ?? '').trim().slice(0, max);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const esMail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
// Teléfono argentino para wa.me: solo dígitos; si no trae 54 adelante se lo agrega.
function linkWhatsapp(contacto) {
  let d = String(contacto).replace(/\D/g, '');
  if (d.length < 8) return null;
  if (d.startsWith('0')) d = d.slice(1);
  if (!d.startsWith('54')) d = '549' + d;
  return `https://wa.me/${d}`;
}

router.post('/', async (req, res) => {
  const b = req.body || {};
  if (b.web) return res.json({ ok: true }); // trampa para robots: campo oculto que una persona no completa
  const nombre = limpio(b.nombre, 120);
  const restaurante = limpio(b.restaurante, 160);
  const contacto = limpio(b.contacto, 160);
  const prioridad = limpio(b.prioridad, 120) || null;
  const mensaje = limpio(b.mensaje, 2000) || null;
  if (nombre.length < 2 || restaurante.length < 2 || contacto.length < 6) {
    return res.status(400).json({ ok: false, error: 'Completá tu nombre, el restaurante y un WhatsApp o mail.' });
  }
  const ip = req.ip || '';
  if (!permitido(ip)) {
    return res.status(429).json({ ok: false, error: 'Recibimos varios pedidos seguidos. Probá en un rato o escribinos por WhatsApp.' });
  }

  let id = null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO demo_requests (nombre, restaurante, contacto, prioridad, mensaje, ip, navegador)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [nombre, restaurante, contacto, prioridad, mensaje, ip, limpio(req.headers['user-agent'], 300)]
    );
    id = rows[0].id;
  } catch (e) {
    console.error('[demo] no se pudo guardar el pedido:', e.message);
  }

  const wa = esMail(contacto) ? null : linkWhatsapp(contacto);
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:15px;color:#15213E">
      <h2 style="margin:0 0 12px">Pedido de demo: ${esc(restaurante)}</h2>
      <p style="margin:4px 0"><b>Nombre:</b> ${esc(nombre)}</p>
      <p style="margin:4px 0"><b>Restaurante:</b> ${esc(restaurante)}</p>
      <p style="margin:4px 0"><b>Contacto:</b> ${esc(contacto)}</p>
      <p style="margin:4px 0"><b>Prioridad a resolver:</b> ${esc(prioridad || '—')}</p>
      <p style="margin:4px 0"><b>Mensaje:</b> ${esc(mensaje || '—')}</p>
      ${wa ? `<p style="margin:18px 0"><a href="${wa}" style="background:#25D366;color:#fff;padding:10px 18px;border-radius:24px;text-decoration:none;font-weight:bold">Escribirle por WhatsApp</a></p>` : ''}
      <p style="margin-top:18px;color:#8a93a3;font-size:12px">Llegó desde la página de Lazarillo${id ? ` · pedido #${id}` : ''}.</p>
    </div>`;
  try {
    const r = await sendEmail(DESTINOS, `Pedido de demo: ${restaurante}`, html, esMail(contacto) ? { replyTo: contacto } : {});
    if (id && r && !r.simulated && r.accepted && r.accepted.length) {
      await pool.query('UPDATE demo_requests SET mail_enviado = TRUE WHERE id = $1', [id]);
    }
  } catch (e) {
    console.error('[demo] no se pudo mandar el mail:', e.message);
  }

  // Para la persona que pidió la demo alcanza con que quede guardado.
  if (!id) return res.status(500).json({ ok: false, error: 'No pudimos registrar el pedido. Escribinos por WhatsApp.' });
  return res.json({ ok: true });
});

module.exports = router;
