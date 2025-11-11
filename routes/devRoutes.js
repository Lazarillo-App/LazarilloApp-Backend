// backend/src/routes/devRoutes.js
const express = require('express');
const { sendEmail } = require('../utils/mailer');
const router = express.Router();
const { reconcile } = require('../controllers/devReconcileController');
const { authRequired } = require('../middleware/authMiddleware');
const requireAppAdmin = require('../middleware/requireAppAdmin');
const pool = require('../config/db');
const { pgQueryRetry } = require('../utils/pgRetry');

router.get('/reconcile', authRequired, requireAppAdmin, reconcile);

router.get('/test-mail', authRequired, requireAppAdmin, async (req, res) => {
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

// Salud de backend y DB (sin auth para poder monitorear fácilmente)
router.get('/health', async (req, res) => {
  try {
    await pgQueryRetry(pool, 'SELECT 1', [], { attempts: 3, baseDelayMs: 400 });
    res.json({ ok: true, app: 'up', db: 'up', ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, app: 'up', db: 'down', error: e.message });
  }
});
module.exports = router;
