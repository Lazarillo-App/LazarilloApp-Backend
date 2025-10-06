// backend/src/routes/devRoutes.js
const express = require('express');
const { sendEmail } = require('../utils/mailer');
const router = express.Router();

router.get('/test-mail', async (req, res) => {
  try {
    const to = req.query.to || process.env.MAIL_REPLY_TO || process.env.SMTP_USER;
    const html = `<h3>Test Lazarillo</h3><p>${new Date().toISOString()}</p>`;
    const info = await sendEmail(to, 'Test Lazarillo', html);
    res.json({ ok: true, ...info });
  } catch (e) {
    console.error('test-mail error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
module.exports = router;
