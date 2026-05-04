'use strict';
 
const router = require('express').Router({ mergeParams: true });
const ctrl   = require('../controllers/branchesController');
 
// Rutas estáticas SIEMPRE antes de /:branchId
router.get('/has-branches', ctrl.hasBranches);
router.get('/main',         ctrl.getMainBranch);   // ← NUEVO
 
// CRUD
router.get   ('/',            ctrl.listBranches);
router.get   ('/:branchId',   ctrl.getBranch);
router.post  ('/',            ctrl.createBranch);
router.patch ('/:branchId',   ctrl.updateBranch);
router.delete('/:branchId',   ctrl.deleteBranch);
 
module.exports = router;
 
 
// ═══════════════════════════════════════════════════════════════════════════
// PATCH 2: branchesController.js
// Agregar el handler getMainBranch al final del archivo (antes del module.exports)
// ═══════════════════════════════════════════════════════════════════════════
 
/**
 * GET /api/businesses/:bizId/branches/main
 * Devuelve el negocio principal formateado como "sucursal virtual".
 * El frontend usa esto para mostrar la sucursal principal en el selector
 * junto a las sucursales reales sin necesidad de un registro en app_branches.
 */
exports.getMainBranch = async (req, res, next) => {
  try {
    const bizId = Number(req.params.bizId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'bizId requerido' });
 
    const { rows } = await pool.query(
      `SELECT
         id,
         name,
         props,
         created_at,
         updated_at
       FROM app_businesses
       WHERE id = $1`,
      [bizId]
    );
 
    if (!rows[0]) {
      return res.status(404).json({ ok: false, error: 'Negocio no encontrado' });
    }
 
    const biz = rows[0];
    const props = biz.props || {};
    const branding = props.branding || {};
 
    // Formatear como branch virtual con id='main'
    const mainBranch = {
      id: 'main',
      business_id: bizId,
      name: biz.name || `Negocio #${bizId}`,
      color: branding.primary || '#1976d2',
      logo_url: branding.logo_url || null,
      address: props.address || {},
      contacts: props.contact || {},
      props: {},
      isMain: true,
      created_at: biz.created_at,
      updated_at: biz.updated_at,
    };
 
    res.json({ ok: true, branch: mainBranch });
  } catch (e) {
    console.error('[branches] getMainBranch:', e);
    next(e);
  }
};