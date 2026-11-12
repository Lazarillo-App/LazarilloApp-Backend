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
//
// blockStaffWrite.salvo('clave'): igual, pero deja pasar al Staff que tenga ese permiso
// habilitado en su rol (Diego 11/11/2026: por defecto restringido, el dueño lo habilita).
'use strict';

const { getStaffPermisos } = require('../services/auth/permisos');

function blockStaffWrite(req, res, next) {
  if (req.businessRole === 'staff') {
    return res.status(403).json({ ok: false, error: 'staff_accion_no_permitida' });
  }
  next();
}

blockStaffWrite.salvo = (clave) => async (req, res, next) => {
  if (req.businessRole !== 'staff') return next();
  try {
    const bizId = Number(req.businessId || req.business?.id || req.params?.businessId || req.params?.id);
    const sp = await getStaffPermisos(req.user?.id, bizId);
    if (sp?.permisos?.[clave]) return next();
  } catch (e) { console.warn('[blockStaffWrite.salvo]', e.message); }
  return res.status(403).json({ ok: false, error: 'staff_accion_no_permitida' });
};

module.exports = blockStaffWrite;
