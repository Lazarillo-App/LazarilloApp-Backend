// backend/src/utils/mailer.js
const nodemailer = require('nodemailer');

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;

  const {
    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE,
  } = process.env;

  if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS) {
    const portNum = Number(SMTP_PORT);
    const secureBool = String(SMTP_SECURE || (portNum === 465)).toLowerCase() === 'true';
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: portNum,
      secure: secureBool,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    console.log('📧 Mailer: SMTP real');
    try { await transporter.verify(); } catch (e) { console.warn('SMTP verify:', e?.message || e); }
    return transporter;
  }

  // DEV (fallback con Ethereal si no hay SMTP_* y MAIL_DEV=1)
  if (process.env.MAIL_DEV === '1') {
    const testAcc = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: testAcc.user, pass: testAcc.pass },
    });
    console.log('📧 Mailer: Ethereal (DEV) – user:', testAcc.user);
    return transporter;
  }

  // Deshabilitado
  transporter = {
    async sendMail(opts) {
      console.log('📭 [mailer disabled] Simulando envío:', { to: opts.to, subject: opts.subject });
      return { messageId: 'disabled' };
    }
  };
  console.warn('⚠️ Mailer deshabilitado: ni SMTP_* ni MAIL_DEV=1 definidos.');
  return transporter;
}

function sanitizeFrom(fromRaw, smtpUser) {
  // Gmail no permite "from" de otro dominio/usuario no verificado
  // Si el MAIL_FROM no incluye el smtpUser, lo forzamos.
  if (!fromRaw) return `"Lazarillo" <${smtpUser}>`;
  const emailMatch = fromRaw.match(/<([^>]+)>/);
  const fromEmail = emailMatch ? emailMatch[1] : fromRaw;
  if (smtpUser && fromEmail.toLowerCase() !== smtpUser.toLowerCase()) {
    return `"Lazarillo" <${smtpUser}>`;
  }
  return fromRaw;
}

/**
 * Envía email. Usa MAIL_FROM (forzado a SMTP_USER si Gmail lo exige) y MAIL_REPLY_TO opcional.
 * @returns {Promise<{messageId: string|null, previewUrl: string|null}>}
 */
async function sendEmail(to, subject, html) {
  const t = await getTransporter();
  const smtpUser = process.env.SMTP_USER || '';
  const fromRaw = process.env.MAIL_FROM || '';
  const replyTo = process.env.MAIL_REPLY_TO || '';

  const from = sanitizeFrom(fromRaw, smtpUser);

  const info = await t.sendMail({
    from,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  });

  const previewUrl = (nodemailer.getTestMessageUrl && nodemailer.getTestMessageUrl(info)) || null;
  if (previewUrl) console.log('🔎 Preview URL:', previewUrl);

  return { messageId: info.messageId || null, previewUrl };
}

module.exports = { sendEmail };
