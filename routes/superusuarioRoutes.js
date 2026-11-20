// routes/superusuarioRoutes.js — montado en /api/superusuarios (authRequired en app.js)
// Todo lo de acá exige es_superusuario (leído de la base en cada pedido).
const router = require('express').Router();
const requireSuperusuario = require('../middleware/requireSuperusuario');
const ctrl = require('../controllers/superusuarioController');
const soporte = require('../services/soporteService');
const ajustes = require('../services/ajustesService');
const tablero = require('../services/tableroService');
const actividad = require('../services/superActividadService');
const telegram = require('../utils/telegram');
const pool = require('../config/db');
const { avisarAlEquipoSinEsperar } = require('../services/notificationService');

router.use(requireSuperusuario);

// Pedidos de los clientes, chat de Anthony, ajustes a medida y Telegram (usuaria 13/11/2026:
// lo atienden los super usuarios, no el /admin de lazarillo.app2025). Van antes de "/:id".
const responder = (res, out) => {
  if (out?.error) return res.status(out.status || 400).json({ ok: false, error: out.error });
  res.json({ ok: true, ...out });
};

router.get('/pedidos', async (req, res, next) => {
  try { responder(res, await soporte.listarPedidos(req.query || {})); } catch (e) { next(e); }
});
router.get('/pedidos/:id', async (req, res, next) => {
  try {
    const p = await soporte.detallePedido(Number(req.params.id));
    if (!p) return res.status(404).json({ ok: false, error: 'no_encontrado' });
    res.json({ ok: true, pedido: p });
  } catch (e) { next(e); }
});
router.patch('/pedidos/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const out = await soporte.actualizarPedido(id, req.body || {});
    if (!out?.error) {
      const b = req.body || {};
      const partes = [];
      if (b.estado) partes.push(`pasó el pedido a «${soporte.NOMBRE_ESTADO[b.estado] || b.estado}»`);
      if (b.asignado_a !== undefined) partes.push(b.asignado_a ? 'asignó el pedido' : 'dejó el pedido sin asignar');
      if (b.tipo || b.alcance !== undefined) partes.push('editó el pedido');
      if (partes.length) await actividad.registrar(req.user.id, 'pedido', partes.join(' y '), { titulo: `Pedido #${id}`, pedido_id: id });
    }
    responder(res, out);
  } catch (e) { next(e); }
});
router.post('/pedidos/:id/respuestas', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const interna = !!req.body?.interna;
    const out = await soporte.responderEquipo(id, req.user.id, req.body?.texto, interna);
    if (!out?.error) {
      await actividad.registrar(req.user.id, 'pedido', interna ? 'dejó una nota interna' : 'le respondió al cliente',
        { titulo: `Pedido #${id}`, detalle: req.body?.texto, pedido_id: id });
    }
    responder(res, out);
  } catch (e) { next(e); }
});

router.get('/soporte/config', async (_req, res, next) => {
  try { res.json({ ok: true, config: await soporte.leerConfig(), telegram: telegram.configurado() }); } catch (e) { next(e); }
});
router.put('/soporte/config', async (req, res, next) => {
  try { responder(res, await soporte.guardarConfig(req.body?.config, req.user.id)); } catch (e) { next(e); }
});

// Telegram: chats que le escribieron al bot (para elegir cuál avisa) y mensaje de prueba.
router.get('/telegram/chats', async (_req, res, next) => {
  try {
    if (!telegram.configurado()) return res.json({ ok: true, configurado: false, chats: [] });
    const r = await telegram.chatsRecientes();
    responder(res, r.error ? { error: r.error } : { configurado: true, chats: r.chats });
  } catch (e) { next(e); }
});
router.post('/telegram/probar', async (req, res, next) => {
  try {
    const config = await soporte.leerConfig();
    const r = await telegram.avisar(config.telegram?.chat_ids || [], '✅ <b>Lazarillo</b>: los avisos de pedidos llegan a este chat.');
    responder(res, r.enviados ? { enviados: r.enviados } : { error: r.error || 'no_salio' });
  } catch (e) { next(e); }
});

router.get('/ajustes', async (_req, res, next) => {
  try { res.json({ ok: true, ajustes: await ajustes.listar(), catalogo: ajustes.CATALOGO }); } catch (e) { next(e); }
});
router.post('/ajustes', async (req, res, next) => {
  try {
    const out = await ajustes.guardar(req.body || {}, req.user.id);
    if (!out?.error) {
      const a = out.ajuste || {};
      await actividad.registrar(req.user.id, 'ajuste', 'guardó un ajuste a medida',
        { titulo: `${a.clave} (${a.alcance}${a.scope_id ? ` #${a.scope_id}` : ''})`, detalle: a.nota, pedido_id: a.solicitud_id });
    }
    responder(res, out);
  } catch (e) { next(e); }
});
router.delete('/ajustes/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT clave, alcance, scope_id FROM ajustes_alcance WHERE id = $1', [Number(req.params.id)]);
    const out = await ajustes.borrar(req.params.id);
    if (!out?.error && rows[0]) {
      await actividad.registrar(req.user.id, 'ajuste', 'borró un ajuste a medida',
        { titulo: `${rows[0].clave} (${rows[0].alcance}${rows[0].scope_id ? ` #${rows[0].scope_id}` : ''})` });
    }
    responder(res, out);
  } catch (e) { next(e); }
});
// Funciones por negocio (Diego 17/11/2026): qué áreas y funciones ve cada negocio.
const NOMBRE_FUNCION = { operacion: 'Operación', rentabilidad: 'Rentabilidad', administracion: 'Administración',
  tableros: 'Tableros', rrhh: 'RRHH', resultados: 'Resultados', recetas: 'Recetas', stock: 'Stock', compras: 'Compras',
  conciliacion: 'Conciliación', 'movimientos-bancarios': 'Movimientos bancarios', clientes: 'Clientes' };
router.get('/funciones', async (_req, res, next) => {
  try { responder(res, await ajustes.funciones()); } catch (e) { next(e); }
});
router.put('/funciones', async (req, res, next) => {
  try {
    const { business_id: bid = null, ocultos, antes = [] } = req.body || {};
    const out = await ajustes.guardarFunciones(bid, ocultos === undefined ? [] : ocultos, req.user.id);
    if (!out?.error) {
      const ahora = out.ocultos || [];
      const prev = Array.isArray(antes) ? antes : [];
      const prendio = prev.filter((x) => !ahora.includes(x)).map((x) => NOMBRE_FUNCION[x] || x);
      const apago = ahora.filter((x) => !prev.includes(x)).map((x) => NOMBRE_FUNCION[x] || x);
      const partes = [prendio.length && `activó ${prendio.join(', ')}`, apago.length && `ocultó ${apago.join(', ')}`].filter(Boolean);
      const que = out.ocultos === null ? 'volvió al default' : (partes.join(' y ') || 'guardó');
      let negocio = 'todos los negocios';
      if (bid) {
        const { rows } = await pool.query('SELECT name FROM app_businesses WHERE id = $1', [Number(bid)]);
        negocio = rows[0]?.name || `#${bid}`;
        // Al equipo del cliente le llega a la campanita (regla «todo ABM a Notificaciones»).
        if (partes.length) {
          avisarAlEquipoSinEsperar({ businessId: Number(bid), actorUserId: req.user.id, type: 'cuenta_funciones',
            title: `Lazarillo ${partes.join(' y ')}`, metadata: { kind: 'cuenta_funciones', ocultos: ahora } });
        }
      }
      await actividad.registrar(req.user.id, 'ajuste', `${que} en ${negocio}`, { titulo: 'Funciones por negocio' });
    }
    responder(res, out);
  } catch (e) { next(e); }
});
// Buscar a quién aplicarle un ajuste: negocios, organizaciones o usuarios por nombre/mail/id.
router.get('/buscar-alcance', async (req, res, next) => {
  try {
    const tipo = String(req.query.tipo || '');
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ ok: true, resultados: [] });
    const like = `%${q}%`;
    const consultas = {
      negocio: `SELECT id, name AS nombre FROM app_businesses WHERE name ILIKE $1 OR id::text = $2 ORDER BY name LIMIT 15`,
      organizacion: `SELECT id, name AS nombre FROM organizations WHERE name ILIKE $1 OR id::text = $2 ORDER BY name LIMIT 15`,
      usuario: `SELECT id, coalesce(display_name, name, email) || ' · ' || email AS nombre FROM app_users WHERE email ILIKE $1 OR coalesce(name,'') ILIKE $1 OR id::text = $2 ORDER BY email LIMIT 15`,
    };
    if (!consultas[tipo]) return res.status(400).json({ ok: false, error: 'tipo_invalido' });
    const { rows } = await pool.query(consultas[tipo], [like, q]);
    res.json({ ok: true, resultados: rows });
  } catch (e) { next(e); }
});

// Avisos del panel (solapa "Admins" de la campana): todo lo que hace el equipo acá.
// Soporte Lazarillo por cuenta (tablero #103): listar y prender/apagar. Al soltar, los super
// usuarios dejan de ver la cuenta; el cliente recibe el aviso en la campanita.
const soporteCuentas = require('../services/soporteCuentasService');
router.get('/soporte-cuentas', async (_req, res, next) => {
  try { responder(res, await soporteCuentas.listar()); } catch (e) { next(e); }
});
router.patch('/soporte-cuentas/:orgId', async (req, res, next) => {
  try { responder(res, await soporteCuentas.cambiar(req.params.orgId, req.body?.activo, req.user.id)); } catch (e) { next(e); }
});

// Calendario de feriados único de Lazarillo (Diego 20/11/2026): lo mantienen los super usuarios.
const feriadosSvc = require('../services/feriadosService');
const ZONA_NOMBRE = (z) => (feriadosSvc.ZONAS.find(([k]) => k === z) || [z, z])[1];
const dm = (f) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;
router.get('/feriados', async (req, res, next) => {
  try { responder(res, await feriadosSvc.listar({ anio: req.query.anio, zona: req.query.zona })); } catch (e) { next(e); }
});
router.post('/feriados', async (req, res, next) => {
  try {
    const out = await feriadosSvc.guardar(null, req.body, req.user.id);
    if (!out.error) actividad.registrar(req.user.id, 'feriado', 'agregó un feriado', { titulo: `Feriado nuevo: ${out.feriado.nombre} (${dm(out.feriado.fecha)}, ${ZONA_NOMBRE(out.feriado.zona)})` }).catch(() => {});
    responder(res, out);
  } catch (e) { next(e); }
});
router.put('/feriados/:id', async (req, res, next) => {
  try {
    const out = await feriadosSvc.guardar(Number(req.params.id), req.body, req.user.id);
    if (!out.error) actividad.registrar(req.user.id, 'feriado', 'editó un feriado', { titulo: `Feriado: ${out.feriado.nombre} (${dm(out.feriado.fecha)}, ${ZONA_NOMBRE(out.feriado.zona)})` }).catch(() => {});
    responder(res, out);
  } catch (e) { next(e); }
});
router.delete('/feriados/:id', async (req, res, next) => {
  try {
    const out = await feriadosSvc.borrar(Number(req.params.id));
    if (!out.error) actividad.registrar(req.user.id, 'feriado', 'borró un feriado', { titulo: `Feriado quitado: ${out.feriado.nombre} (${dm(out.feriado.fecha)}, ${ZONA_NOMBRE(out.feriado.zona)})` }).catch(() => {});
    responder(res, out);
  } catch (e) { next(e); }
});

router.get('/actividad', async (req, res, next) => {
  try { responder(res, await actividad.listar(req.user.id, req.query.limite)); } catch (e) { next(e); }
});
router.post('/actividad/visto', async (req, res, next) => {
  try { responder(res, await actividad.marcarVisto(req.user.id)); } catch (e) { next(e); }
});

// Tablero de tareas del equipo (usuaria 13/11/2026): pendientes, notas, quién lo hace.
router.get('/tareas', async (_req, res, next) => {
  try { responder(res, await tablero.listar()); } catch (e) { next(e); }
});
router.get('/tareas/:id', async (req, res, next) => {
  try {
    const t = await tablero.detalle(Number(req.params.id));
    if (!t) return res.status(404).json({ ok: false, error: 'no_encontrada' });
    res.json({ ok: true, tarea: t });
  } catch (e) { next(e); }
});
router.post('/tareas', async (req, res, next) => {
  try { responder(res, await tablero.crear(req.body || {}, req.user.id)); } catch (e) { next(e); }
});
router.get('/guia', async (_req, res, next) => {
  try { responder(res, await tablero.leerGuia()); } catch (e) { next(e); }
});
router.put('/guia', async (req, res, next) => {
  try { responder(res, await tablero.guardarGuia(req.body?.texto, req.user.id)); } catch (e) { next(e); }
});
router.post('/tareas/lote', async (req, res, next) => {
  try { responder(res, await tablero.crearLote(req.body?.tareas, req.user.id)); } catch (e) { next(e); }
});
router.patch('/tareas/:id', async (req, res, next) => {
  try { responder(res, await tablero.actualizar(Number(req.params.id), req.body || {}, req.user.id)); } catch (e) { next(e); }
});
router.delete('/tareas/:id', async (req, res, next) => {
  try { responder(res, await tablero.borrar(Number(req.params.id), req.user.id)); } catch (e) { next(e); }
});
router.post('/tareas/:id/notas', async (req, res, next) => {
  try { responder(res, await tablero.agregarNota(Number(req.params.id), req.body?.texto, req.user.id)); } catch (e) { next(e); }
});
router.delete('/tareas/:id/notas/:notaId', async (req, res, next) => {
  try { responder(res, await tablero.borrarNota(Number(req.params.id), Number(req.params.notaId), req.user.id)); } catch (e) { next(e); }
});

// Manual de Lazarillo (16/11/2026): capítulos e imágenes. La lectura para todos está en /api/manual.
const manual = require('../services/manualService');
const multer = require('multer');
// Imágenes del Manual en la base (manual_imagenes): sirven igual en testing y en producción.
const subirImagen = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /image\/(png|jpe?g|webp)/i.test(file.mimetype)),
});
router.get('/manual', async (_req, res, next) => {
  try { responder(res, await manual.listar({ conBorradores: true })); } catch (e) { next(e); }
});
router.post('/manual/imagen', subirImagen.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'falta_imagen' });
    res.json({ ok: true, url: await manual.guardarImagen(req.file, req.user.id) });
  } catch (e) { next(e); }
});
router.put('/manual/:id', async (req, res, next) => {
  try { responder(res, await manual.guardar(req.params.id, req.body, req.user.id)); } catch (e) { next(e); }
});
router.delete('/manual/:id', async (req, res, next) => {
  try { responder(res, await manual.borrar(req.params.id, req.user.id)); } catch (e) { next(e); }
});

// Super usuarios (Diego).
router.get('/', ctrl.listar);
router.put('/:id', ctrl.cambiar);

module.exports = router;
