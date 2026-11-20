// routes/serviciosRoutes.js
// Recetas de tipo Servicio (ver services/servicioCosto.js). Se monta en /api/businesses/:businessId/servicios.
'use strict';
const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../config/db');
const { requireBusinessRole } = require('../middleware/authMiddleware');
const { avisarAbm } = require('../services/notificationService');
const { invalidateCacheForBiz } = require('../middleware/cacheJson');
const srv = require('../services/servicioCosto');

router.use(requireBusinessRole('admin'));
router.use((req, res, next) => {
  if (Number(req.params.businessId) !== Number(req.businessId)) {
    return res.status(403).json({ ok: false, error: 'business_mismatch' });
  }
  next();
});

const bizDe = (req) => Number(req.params.businessId);
const artDe = (req) => Number(req.params.articleId);

async function nombreArticulo(bizId, articleId) {
  const { rows } = await pool.query(
    `SELECT nombre FROM maxi_articles WHERE articulo_id = $2 AND (business_id = $1 OR business_id IN (
       SELECT b2.id FROM app_businesses b1 JOIN app_businesses b2 ON b2.organization_id = b1.organization_id WHERE b1.id = $1))
     ORDER BY (business_id = $1) DESC LIMIT 1`, [bizId, articleId]).catch(() => ({ rows: [] }));
  return rows[0]?.nombre || `Artículo ${articleId}`;
}

// GET /servicios/anclas → anclas del negocio (para elegir en un servicio derivado)
router.get('/anclas', async (req, res, next) => {
  try { res.json({ ok: true, anclas: await srv.listarAnclas(bizDe(req)) }); } catch (e) { next(e); }
});

// GET /servicios/:articleId → config guardada + cálculo de su ancla
router.get('/:articleId', async (req, res, next) => {
  try {
    const bizId = bizDe(req), articleId = artDe(req);
    const { rows } = await pool.query(
      `SELECT servicio FROM recetas WHERE business_id = $1 AND article_id = $2 AND active = TRUE
        ORDER BY es_promo ASC, id DESC LIMIT 1`, [bizId, articleId]);
    const config = srv.normalizarConfig(rows[0]?.servicio);
    if (!config) return res.json({ ok: true, config: null, calculo: null });
    const anclaId = config.tipo === 'ancla' ? articleId : config.ancla;
    const calculo = await srv.calcularAncla(bizId, anclaId);
    res.json({ ok: true, config, calculo });
  } catch (e) { next(e); }
});

// POST /servicios/:articleId/calculo {config} → vista previa de una ancla sin guardar
router.post('/:articleId/calculo', async (req, res, next) => {
  try {
    const config = srv.normalizarConfig(req.body?.config);
    if (!config || config.tipo !== 'ancla') return res.status(400).json({ ok: false, error: 'config_invalida' });
    res.json({ ok: true, calculo: await srv.calcularAncla(bizDe(req), artDe(req), { configOverride: config }) });
  } catch (e) { next(e); }
});

// PUT /servicios/:articleId {config} → el artículo pasa a ser servicio (ancla o derivado) y se recalcula la familia
router.put('/:articleId', async (req, res, next) => {
  const bizId = bizDe(req), articleId = artDe(req);
  const config = srv.normalizarConfig(req.body?.config);
  if (!Number.isFinite(articleId) || !config) return res.status(400).json({ ok: false, error: 'config_invalida' });
  if (config.tipo === 'derivado' && config.ancla === articleId) return res.status(400).json({ ok: false, error: 'ancla_propia' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (config.tipo === 'derivado') {
      const { rows: a } = await client.query(
        `SELECT 1 FROM recetas WHERE business_id = $1 AND article_id = $2 AND active = TRUE AND servicio->>'tipo' = 'ancla' LIMIT 1`,
        [bizId, config.ancla]);
      if (!a.length) { await client.query('ROLLBACK'); return res.status(400).json({ ok: false, error: 'ancla_inexistente' }); }
    }
    const { rows: prev } = await client.query(
      `SELECT id, servicio FROM recetas WHERE business_id = $1 AND article_id = $2 AND active = TRUE
        ORDER BY es_promo ASC, id DESC LIMIT 1`, [bizId, articleId]);
    const antes = srv.normalizarConfig(prev[0]?.servicio);
    const nombre = await nombreArticulo(bizId, articleId);
    if (prev.length) {
      await client.query(`UPDATE recetas SET servicio = $2, es_promo = FALSE, updated_at = NOW() WHERE id = $1`,
        [prev[0].id, JSON.stringify(config)]);
    } else {
      await client.query(
        `INSERT INTO recetas (article_id, business_id, nombre, porciones, porcentaje_venta, costo_total, es_promo,
                              active, origen, servicio, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 1, 0, 0, FALSE, TRUE, 'servicio', $4, $5, NOW(), NOW())`,
        [articleId, bizId, nombre, JSON.stringify(config), req.user?.id || null]);
    }
    const calculo = await srv.recalcularServicio(bizId, articleId, client);
    // Si era derivado de otra ancla, esa familia también cambia.
    if (antes?.tipo === 'derivado' && (config.tipo !== 'derivado' || antes.ancla !== config.ancla)) {
      await srv.recalcularServicio(bizId, antes.ancla, client);
    }
    await client.query('COMMIT');
    invalidateCacheForBiz(bizId);
    const titulo = config.tipo === 'ancla'
      ? `Servicio ancla: ${nombre}` : `Servicio: ${nombre} (${String(Math.round(config.factor * 1000) / 10).replace('.', ',')} % de la ancla)`;
    avisarAbm(req, { businessId: bizId, type: 'servicio_config', title: titulo, metadata: { articleId, tipo: config.tipo }, clave: `servicio:${articleId}` });
    res.json({ ok: true, config, calculo });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    next(e);
  } finally { client.release(); }
});

// DELETE /servicios/:articleId → deja de ser servicio (vuelve a Producto, costo 0 hasta que se le carguen insumos)
router.delete('/:articleId', async (req, res, next) => {
  const bizId = bizDe(req), articleId = artDe(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, servicio FROM recetas WHERE business_id = $1 AND article_id = $2 AND active = TRUE AND servicio IS NOT NULL
        ORDER BY id DESC LIMIT 1`, [bizId, articleId]);
    const antes = srv.normalizarConfig(rows[0]?.servicio);
    if (!rows.length) { await client.query('ROLLBACK'); return res.json({ ok: true, cambiado: false }); }
    if (antes?.tipo === 'ancla') {
      const { rows: hijos } = await client.query(
        `SELECT COUNT(*)::int AS n FROM recetas WHERE business_id = $1 AND active = TRUE AND servicio->>'tipo' = 'derivado'
           AND (servicio->>'ancla')::bigint = $2`, [bizId, articleId]);
      if (hijos[0].n > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, error: 'ancla_con_servicios', servicios: hijos[0].n,
          message: `Hay ${hijos[0].n} servicios atados a esta ancla. Elegiles otra ancla antes.` });
      }
    }
    await client.query(
      `UPDATE recetas SET servicio = NULL, costo_total = 0, costo_unitario = 0, costo_total_con_merma = 0, updated_at = NOW()
        WHERE id = $1`, [rows[0].id]);
    if (antes?.tipo === 'derivado') await srv.recalcularServicio(bizId, antes.ancla, client);
    await client.query('COMMIT');
    invalidateCacheForBiz(bizId);
    const nombre = await nombreArticulo(bizId, articleId);
    avisarAbm(req, { businessId: bizId, type: 'servicio_config', title: `Ya no es servicio: ${nombre}`, metadata: { articleId } });
    res.json({ ok: true, cambiado: true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    next(e);
  } finally { client.release(); }
});

module.exports = router;
