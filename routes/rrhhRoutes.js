// routes/rrhhRoutes.js
// Rutas del módulo RRHH · Etapa 1 (Cronogramas).
//
// Se montan bajo /api/businesses/:businessId/rrhh en app.js.
// El guard global de /api (authRequired + loadActiveBusiness) corre antes y
// deja req.businessId validado, igual que el resto de /api/businesses/:bizId/...
const express = require('express');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/rrhhController');

// Config del módulo (empleados + puestos + fechas + espacios con turnos)
router.get('/config', ctrl.getConfig);
router.put('/config', ctrl.putConfig);

// Empleados (tabla propia de RRHH; MaxiRest solo como semilla, con selección)
router.get('/empleados/nomina-maxirest', ctrl.listarNominaMaxirest);
router.post('/empleados/importar', ctrl.importarNomina);
router.post('/empleados', ctrl.crearEmpleado);
router.patch('/empleados/:id', ctrl.editarEmpleado);

// Nómina compartida con otro negocio de la cartera (vinculada, no copia)
router.get('/nomina/candidatos', ctrl.candidatosNomina);
router.put('/nomina/vinculo', ctrl.vincularNomina);
router.delete('/nomina/vinculo', ctrl.desvincularNomina);

// Semanas de cronograma (la lista va ANTES que las parametrizadas)
router.get('/semanas', ctrl.listarSemanas);
router.get('/semanas/:semana', ctrl.getSemana);
router.put('/semanas/:semana', ctrl.putSemana);
router.delete('/semanas/:semana', ctrl.borrarSemana);

module.exports = router;
