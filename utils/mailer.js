// utils/mailer.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: process.env.SMTP_USER ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  } : undefined,
});

exports.sendEmail = async (to, subject, html) => {
  // Modo DEV: si no hay SMTP configurado, logueamos
  if (!process.env.SMTP_HOST) {
    console.log('[DEV email]', { to, subject, html });
    return;
  }
  await transporter.sendMail({
    from: process.env.SMTP_FROM || '"Lazarillo" <no-reply@lazarillo>',
    to, subject, html,
  });
};
