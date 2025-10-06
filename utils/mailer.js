// utils/mailer.js
const nodemailer = require('nodemailer');

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;

  // 1) SMTP real por env
  const {
    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
    SMTP_SECURE, MAIL_FROM, MAIL_FROM_NAME,
  } = process.env;

  if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: String(SMTP_SECURE || '').toLowerCase() === 'true',
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    return transporter;
  }

  // 2) Modo dev con Ethereal
  if (process.env.MAIL_DEV === '1') {
    const testAcc = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: testAcc.user, pass: testAcc.pass },
    });
    console.log('📧 MAIL_DEV=1 activado. Usando cuenta Ethereal:', testAcc.user);
    return transporter;
  }

  // 3) Sin mail → transport "fake": no rompe
  transporter = {
    async sendMail(opts) {
      console.log('📭 [mailer disabled] Simulando envío:', {
        to: opts.to, subject: opts.subject,
      });
      return { messageId: 'disabled', previewUrl: null };
    }
  };
  return transporter;
}

async function sendEmail(to, subject, html) {
  const t = await getTransporter();

  const from = process.env.MAIL_FROM || 'no-reply@lazarillo.com.ar';
  const fromName = process.env.MAIL_FROM_NAME || 'Lazarillo';

  const info = await t.sendMail({
    from: `"${fromName}" <${from}>`,
    to,
    subject,
    html,
  });

  // Si es Ethereal, mostrar preview
  const preview = nodemailer.getTestMessageUrl?.(info);
  if (preview) console.log('🔎 Preview URL:', preview);

  return info;
}

module.exports = { sendEmail };
