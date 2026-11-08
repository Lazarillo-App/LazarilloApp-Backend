// routes/superusuarioRoutes.js — montado en /api/superusuarios (authRequired en app.js)
const router = require('express').Router();
const requireSuperusuario = require('../middleware/requireSuperusuario');
const ctrl = require('../controllers/superusuarioController');

router.use(requireSuperusuario);
router.get('/', ctrl.listar);
router.put('/:id', ctrl.cambiar);

module.exports = router;
