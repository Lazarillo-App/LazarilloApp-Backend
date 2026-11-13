// middleware/avisoAbm.js
// Regla «todo ABM queda en Notificaciones» (Diego 12/11/2026) para rutas que ya existen, sin
// tocar cada controlador: se engancha en la ruta, mira la respuesta y, si salió bien, deja el
// aviso del lado del servidor (queda aunque se cierre la pestaña).
//
//   router.put('/:id', avisoAbm({ antes, armar }), ctrl.actualizar)
//
//   antes(req)               → opcional, corre ANTES del controlador (ej. el nombre de lo que
//                              se va a borrar o los datos previos para el antes → después).
//   armar(req, body, previo) → { type, title, message?, metadata?, clave?, conAutor? } o null
//                              para no avisar. Corre después de responder: no demora al usuario.
//
// conAutor (default true): el autor lo recibe ya leído, en «Mías». En false le llega solo al
// resto del equipo: para las acciones cuyo aviso propio ya lo guarda la pantalla con su
// «Deshacer» (mover, discontinuar, agrupaciones), así no sale duplicado.
const getBusinessId = require('../utils/getBusinessId');
const { avisarAlEquipoSinEsperar } = require('../services/notificationService');

function avisoAbm({ antes = null, armar, scope = 'insumo' }) {
  return async (req, res, next) => {
    let previo = null;
    if (antes) {
      try { previo = await antes(req); } catch (e) { previo = null; }
    }
    const json = res.json.bind(res);
    let cuerpo;
    res.json = (body) => { cuerpo = body; return json(body); };
    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      if (cuerpo && cuerpo.ok === false) return;
      Promise.resolve()
        .then(() => armar(req, cuerpo || {}, previo))
        .then((a) => {
          if (!a || !a.title) return;
          const businessId = Number(a.businessId ?? getBusinessId(req));
          const actor = Number(req.user?.id) || null;
          avisarAlEquipoSinEsperar({
            businessId, actorUserId: actor, type: a.type, title: a.title, message: a.message ?? null,
            metadata: { kind: a.type, scope, ...(a.metadata || {}) },
            incluirActor: a.conAutor !== false && !!actor,
            clave: a.clave ?? null, agruparMin: a.agruparMin ?? 30,
          });
        })
        .catch((e) => console.warn('[avisoAbm]', req.method, req.originalUrl, e?.message));
    });
    return next();
  };
}

module.exports = avisoAbm;
