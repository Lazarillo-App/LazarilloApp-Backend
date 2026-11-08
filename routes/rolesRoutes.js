// routes/rolesRoutes.js — roles a medida del negocio activo (ver controllers/rolesController.js)
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/rolesController');

router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.put('/administracion', ctrl.setAdministracion);
router.delete('/administracion', ctrl.resetAdministracion);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
