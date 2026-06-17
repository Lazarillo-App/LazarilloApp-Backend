// utils/mailer.js
//
// Wrapper de envío de mail vía SMTP usando nodemailer.
// Configurar con variables de entorno:
//   SMTP_HOST       (ej: smtp.gmail.com, smtp.resend.com, smtp.mailgun.org)
//   SMTP_PORT       (ej: 465 para SSL, 587 para TLS/STARTTLS)
//   SMTP_SECURE     ('true' si 465, 'false' si 587)
//   SMTP_USER       (usuario/login)
//   SMTP_PASS       (password o app-password)
//   SMTP_FROM       (remitente, ej: 'Lazarillo <noreply@lazarillo.app>')
//
// En desarrollo, si falta config, simula el envío y loguea a consola.

const nodemailer = require('nodemailer');

const {
  SMTP_HOST,
  SMTP_PORT = '587',
  SMTP_SECURE = 'false',
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM = 'Lazarillo <noreply@lazarillo.app>',
  NODE_ENV,
} = process.env;

let transporter = null;
let mailerReady = false;

function buildTransporter() {
  if (transporter) return transporter;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn('[mailer] ⚠️  SMTP no configurado — los mails se loguean por consola, no se envían realmente.');
    mailerReady = false;
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(SMTP_SECURE).toLowerCase() === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  mailerReady = true;
  console.log(`[mailer] ✅ SMTP listo: ${SMTP_HOST}:${SMTP_PORT} (secure=${SMTP_SECURE})`);
  return transporter;
}

/**
 * Envía un mail. Si SMTP no está configurado, lo loguea por consola pero no rompe.
 * Devuelve { accepted, rejected, messageId, simulated } compatible con el código que ya lo usa.
 *
 * @param {string|string[]} to
 * @param {string} subject
 * @param {string} html
 * @param {object} [opts]   { from, text, replyTo, attachments }
 */
async function sendEmail(to, subject, html, opts = {}) {
  const tx = buildTransporter();
  const recipients = Array.isArray(to) ? to : [to];

  if (!tx) {
    // Modo dev / sin SMTP: simular
    console.log('───── [mailer:simulated] ─────');
    console.log('  TO:     ', recipients.join(', '));
    console.log('  SUBJECT:', subject);
    console.log('  HTML:   ', html?.slice(0, 200), html?.length > 200 ? '…(truncado)' : '');
    console.log('──────────────────────────────');
    return {
      accepted: recipients,
      rejected: [],
      messageId: 'simulated-' + Date.now(),
      simulated: true,
    };
  }

  try {
    const info = await tx.sendMail({
      from: opts.from || SMTP_FROM,
      to: recipients,
      subject,
      html,
      text: opts.text,
      replyTo: opts.replyTo,
      attachments: opts.attachments,
    });
    return {
      accepted: info.accepted || recipients,
      rejected: info.rejected || [],
      messageId: info.messageId,
      simulated: false,
    };
  } catch (e) {
    console.error('[mailer] ❌ sendMail error:', e.message);
    return {
      accepted: [],
      rejected: recipients,
      error: e.message,
      simulated: false,
    };
  }
}

module.exports = { sendEmail };