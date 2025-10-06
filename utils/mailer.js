// backend/src/utils/mailer.js
const nodemailer = require('nodemailer');

let transporter = null;

function coerceBool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

async function getTransporter() {
  if (transporter) return transporter;

  const {
    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, MAIL_DEV,
  } = process.env;

  if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS) {
    const portNum = Number(SMTP_PORT);
    const secureBool = coerceBool(SMTP_SECURE, portNum === 465);

    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: portNum,
      secure: secureBool,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      logger: true,   // 👈 log SMTP en consola (Render logs)
      debug: true,    // 👈 log detallado
    });

    console.log('📧 Mailer: SMTP real', { host: SMTP_HOST, port: portNum, secure: secureBool, user: SMTP_USER });
    try { await transporter.verify(); console.log('✅ SMTP verificado'); }
    catch (e) { console.error('❌ SMTP verify error:', e?.message || e); }
    return transporter;
  }

  if (MAIL_DEV === '1') {
    const test = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: test.user, pass: test.pass },
      logger: true,
      debug: true,
    });
    console.log('📧 Mailer: Ethereal (DEV)', { user: test.user });
    return transporter;
  }

  transporter = {
    async sendMail(opts) {
      console.warn('📭 [mailer disabled] Simulando envío:', { to: opts.to, subject: opts.subject });
      return { messageId: 'disabled', accepted: [], rejected: [], response: 'DISABLED' };
    }
  };
  console.warn('⚠️ Mailer deshabilitado (sin SMTP_* y sin MAIL_DEV=1)');
  return transporter;
}

function sanitizeFrom(fromRaw, smtpUser) {
  // Gmail exige que el "from" sea el user autenticado o un alias verificado.
  if (!fromRaw) return `"Lazarillo" <${smtpUser}>`;
  const m = fromRaw.match(/<([^>]+)>/);
  const email = m ? m[1] : fromRaw;
  if (smtpUser && email.toLowerCase() !== String(smtpUser).toLowerCase()) {
    console.warn('ℹ️ Forzando FROM a SMTP_USER para evitar rechazo de Gmail:', { fromRaw, smtpUser });
    return `"Lazarillo" <${smtpUser}>`;
  }
  return fromRaw;
}

/**
 * Envía email y retorna detalles útiles para diagnóstico
 * @returns {Promise<{messageId:string|null, previewUrl:string|null, accepted:string[], rejected:string[], response?:string}>}
 */
async function sendEmail(to, subject, html) {
  const t = await getTransporter();
  const smtpUser = process.env.SMTP_USER || '';
  const fromRaw  = process.env.MAIL_FROM || '';
  const replyTo  = process.env.MAIL_REPLY_TO || '';
  const from     = sanitizeFrom(fromRaw, smtpUser);

  const info = await t.sendMail({
    from,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {})
  });

  const previewUrl = (nodemailer.getTestMessageUrl && nodemailer.getTestMessageUrl(info)) || null;
  if (previewUrl) console.log('🔎 Preview URL:', previewUrl);

  console.log('📨 sendMail result:', {
    messageId: info?.messageId,
    accepted : info?.accepted,
    rejected : info?.rejected,
    response : info?.response,
  });

  return {
    messageId: info?.messageId || null,
    previewUrl,
    accepted: info?.accepted || [],
    rejected: info?.rejected || [],
    response: info?.response || '',
  };
}

module.exports = { sendEmail };
