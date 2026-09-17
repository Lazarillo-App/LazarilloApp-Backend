// routes/aiRoutes.js
const router = require('express').Router();
const { assist } = require('../controllers/aiAssistController');

// Cualquier usuario logueado (cuenta activa/trial) puede usar el asistente de
// onboarding — no depende de tener un negocio activo, por eso este router se
// monta antes del guard de negocio (ver app.js).
router.post('/assist', assist);

module.exports = router;
