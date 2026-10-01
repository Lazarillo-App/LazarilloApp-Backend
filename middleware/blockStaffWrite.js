// middleware/blockStaffWrite.js
//
// Vista Operación: un Staff puede editar RECETAS (vía el circuito de
// propuestas, ver services/recetaProposals.js) pero ninguna otra escritura
// directa — renombrar, mover de agrupación, cambiar precio/objetivo,
// discontinuar, crear listas, etc. La vista restringida de Staff (Fase 4) ya
// no muestra estos controles; esto es el cierre server-side para que
// tampoco se puedan forzar llamando a la API directo.
//
// req.businessRole ya lo resuelve loadActiveBusiness (middleware/authMiddleware.js)
// para TODAS las rutas /api/*, así que alcanza con chequearlo acá.
'use strict';

module.exports = function blockStaffWrite(req, res, next) {
  if (req.businessRole === 'staff') {
    return res.status(403).json({ ok: false, error: 'staff_accion_no_permitida' });
  }
  next();
};
