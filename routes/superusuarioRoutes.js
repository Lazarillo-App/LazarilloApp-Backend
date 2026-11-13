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

// Super usuarios (Diego).
router.get('/', ctrl.listar);
router.put('/:id', ctrl.cambiar);

module.exports = router;
