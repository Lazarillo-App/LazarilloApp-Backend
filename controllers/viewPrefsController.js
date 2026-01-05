/* eslint-disable no-console */
const pool = require('../config/db');

const VALID_MODES = ['by-subrubro', 'by-categoria'];

/**
 * GET /api/businesses/:id/view-prefs
 * Devuelve todas las vistas guardadas para el usuario en ese negocio
 * resp: { ok: true, byGroup: { [agrupacionId]: 'by-subrubro' | 'by-categoria' } }
 */
exports.getViewPrefs = async (req, res, next) => {
  try {
    const biz = req.business;
    const user = req.user;

    if (!biz?.id || !user?.id) {
      return res.status(400).json({ ok: false, error: 'missing_business_or_user' });
    }

    const { rows } = await pool.query(
      `SELECT agrupacion_id, view_mode
       FROM app_user_group_view_prefs
       WHERE business_id = $1 AND user_id = $2`,
      [biz.id, user.id]
    );

    const byGroup = {};
    for (const r of rows) {
      byGroup[r.agrupacion_id] = r.view_mode;
    }

    res.json({ ok: true, byGroup });
  } catch (e) {
    console.error('getViewPrefs error:', e);
    next(e);
  }
};

/**
 * POST /api/businesses/:id/view-prefs
 * body: { agrupacionId, viewMode }
 */
exports.saveViewPref = async (req, res, next) => {
  try {
    const biz = req.business;
    const user = req.user;
    const { agrupacionId, viewMode } = req.body || {};

    const groupIdNum = Number(agrupacionId);

    if (!biz?.id || !user?.id || !Number.isFinite(groupIdNum)) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }
    if (!VALID_MODES.includes(viewMode)) {
      return res.status(400).json({ ok: false, error: 'invalid_view_mode' });
    }

    await pool.query(
      `INSERT INTO app_user_group_view_prefs (user_id, business_id, agrupacion_id, view_mode, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, business_id, agrupacion_id)
       DO UPDATE SET
         view_mode = EXCLUDED.view_mode,
         updated_at = NOW()`,
      [user.id, biz.id, groupIdNum, viewMode]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('saveViewPref error:', e);
    next(e);
  }
};

/* =========================================================
   FAVORITA POR USUARIO + NEGOCIO
   GET  /api/businesses/:id/fav-group
   POST /api/businesses/:id/fav-group
   ========================================================= */

// controllers/viewPrefsController.js

exports.getFavoriteGroup = async (req, res, next) => {
  try {
    const biz = req.business;
    const user = req.user;
    const scope = req.query.scope || 'articulo';  // 🆕 Leer scope del query

    if (!biz?.id || !user?.id) {
      return res.status(400).json({ ok: false, error: 'missing_business_or_user' });
    }

    const { rows } = await pool.query(
      `SELECT agrupacion_id
       FROM app_user_group_favs
       WHERE business_id = $1 AND user_id = $2 AND scope = $3
       LIMIT 1`,
      [biz.id, user.id, scope]  // 🆕 Agregar scope
    );

    const favoriteGroupId = rows.length ? Number(rows[0].agrupacion_id) : null;
    res.json({ ok: true, favoriteGroupId, scope });
  } catch (e) {
    console.error('getFavoriteGroup error:', e);
    next(e);
  }
};

exports.saveFavoriteGroup = async (req, res, next) => {
  try {
    const biz = req.business;
    const user = req.user;
    const { agrupacionId, scope = 'articulo' } = req.body || {};

    if (!biz?.id || !user?.id) {
      return res.status(400).json({ ok: false, error: 'missing_business_or_user' });
    }

    // ✅ Validar scope
    if (!['articulo', 'insumo'].includes(scope)) {
      return res.status(400).json({ ok: false, error: 'invalid_scope' });
    }

    const groupIdNum = Number(agrupacionId);

    // Si es null/undefined → borrar favorita
    if (!Number.isFinite(groupIdNum)) {
      await pool.query(
        `DELETE FROM app_user_group_favs
         WHERE user_id = $1 AND business_id = $2 AND scope = $3`,
        [user.id, biz.id, scope]
      );
      return res.json({ ok: true, favoriteGroupId: null, scope });
    }

    // 🆕 Validar que el grupo existe según el scope
    const tableName = scope === 'articulo' ? 'agrupaciones' : 'insumo_groups';
    const checkQuery = `SELECT id FROM ${tableName} WHERE id = $1 AND business_id = $2 LIMIT 1`;
    const { rows: checkRows } = await pool.query(checkQuery, [groupIdNum, biz.id]);

    if (!checkRows.length) {
      return res.status(404).json({ 
        ok: false, 
        error: 'group_not_found',
        message: `No se encontró ${scope === 'articulo' ? 'agrupación' : 'grupo'} con id ${groupIdNum}`
      });
    }

    // ✅ Guardar favorita
    await pool.query(
      `INSERT INTO app_user_group_favs (user_id, business_id, agrupacion_id, scope, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, business_id, scope)
       DO UPDATE SET agrupacion_id = EXCLUDED.agrupacion_id, updated_at = NOW()`,
      [user.id, biz.id, groupIdNum, scope]
    );

    res.json({ ok: true, favoriteGroupId: groupIdNum, scope });
  } catch (e) {
    console.error('saveFavoriteGroup error:', e);
    next(e);
  }
};