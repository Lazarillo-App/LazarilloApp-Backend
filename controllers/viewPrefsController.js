// controllers/viewPrefsController.js
/* eslint-disable no-console */
const pool = require('../config/db');

const VALID_MODES = ['by-subrubro', 'by-categoria', 'elaborados', 'no-elaborados'];


// ── GET /businesses/:id/view-prefs?scope=articulo&divisionId=X ──
exports.getViewPrefs = async (req, res) => {
  try {
    const businessId = Number(req.params.id);
    const divisionId = req.query.divisionId ? Number(req.query.divisionId) : null;
    const scope = req.query.scope || null; // 'articulo' | 'insumo' | null (todos)

    // Construir WHERE dinámico
    const conditions = ['business_id = $1'];
    const params = [businessId];

    if (Number.isFinite(divisionId)) {
      conditions.push(`division_id = $${params.length + 1}`);
      params.push(divisionId);
    } else {
      conditions.push('(division_id IS NULL OR division_id = 0)');
    }

    if (scope) {
      // scope explícito: filtrar solo ese scope
      // compatibilidad: si scope='articulo', incluir también filas sin scope (legacy)
      conditions.push(`(scope = $${params.length + 1} OR scope IS NULL)`);
      params.push(scope);
    }

    const { rows } = await pool.query(
      `SELECT agrupacion_id, view_mode, scope
         FROM business_view_prefs
        WHERE ${conditions.join(' AND ')}`,
      params
    );

    // Separar por scope para el frontend
    const byGroup = {};       // artículos (scope='articulo' o null legacy)
    const byInsumoGroup = {}; // insumos (scope='insumo')

    for (const row of rows) {
      const gId = Number(row.agrupacion_id);
      const vm = row.view_mode;
      const s = row.scope;

      if (s === 'insumo') {
        byInsumoGroup[gId] = vm;
      } else {
        // 'articulo', null, u otro → byGroup (artículos)
        byGroup[gId] = vm;
      }
    }

    return res.json({ ok: true, byGroup, byInsumoGroup });
  } catch (e) {
    console.error('getViewPrefs error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};


// ── POST /businesses/:id/view-prefs ──
// Body: { agrupacionId, viewMode, divisionId?, scope? }
exports.saveViewPref = async (req, res) => {
  try {
    const businessId = Number(req.params.id);
    const agrupacionId = Number(req.body?.agrupacionId);
    const viewMode = String(req.body?.viewMode || '').trim();
    const divisionId = req.body?.divisionId ? Number(req.body.divisionId) : null;
    const scope = req.body?.scope || 'articulo'; // default 'articulo' para compatibilidad

    if (!Number.isFinite(businessId) || !Number.isFinite(agrupacionId) || !viewMode) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const divVal = Number.isFinite(divisionId) ? divisionId : null;

    await pool.query(
      `INSERT INTO business_view_prefs (business_id, agrupacion_id, view_mode, division_id, scope)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (business_id, agrupacion_id, COALESCE(division_id, 0), scope)
       DO UPDATE SET view_mode = EXCLUDED.view_mode, updated_at = NOW()`,
      [businessId, agrupacionId, viewMode, divVal, scope]
    );

    return res.json({ ok: true });
  } catch (e) {
    // Si falla el ON CONFLICT (constraint no existe), intentar upsert manual
    if (e.code === '42P10' || e.code === '23505') {
      try {
        const divVal = Number.isFinite(Number(req.body?.divisionId)) ? Number(req.body.divisionId) : null;
        const scope = req.body?.scope || 'articulo';
        const businessId = Number(req.params.id);
        const agrupacionId = Number(req.body?.agrupacionId);
        const viewMode = String(req.body?.viewMode || '');

        // Intentar UPDATE primero, luego INSERT
        const upd = await pool.query(
          `UPDATE business_view_prefs
             SET view_mode = $1, updated_at = NOW()
           WHERE business_id = $2 AND agrupacion_id = $3
             AND (division_id = $4 OR (division_id IS NULL AND $4 IS NULL))
             AND (scope = $5 OR (scope IS NULL AND $5 = 'articulo'))`,
          [viewMode, businessId, agrupacionId, divVal, scope]
        );
        if (!upd.rowCount) {
          await pool.query(
            `INSERT INTO business_view_prefs (business_id, agrupacion_id, view_mode, division_id, scope)
             VALUES ($1, $2, $3, $4, $5)`,
            [businessId, agrupacionId, viewMode, divVal, scope]
          );
        }
        return res.json({ ok: true });
      } catch (e2) {
        console.error('saveViewPref fallback error:', e2.message);
      }
    }
    console.error('saveViewPref error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

/* =========================================================
   FAVORITA POR USUARIO + NEGOCIO + DIVISIÓN
   GET  /api/businesses/:id/fav-group
   POST /api/businesses/:id/fav-group
   ========================================================= */

exports.getFavoriteGroup = async (req, res, next) => {
  try {
    const biz = req.business;
    const user = req.user;

    const scope = req.query.scope || 'articulo';

    const divisionIdRaw = req.query.divisionId;
    const divisionId =
      divisionIdRaw == null || divisionIdRaw === '' ? null : Number(divisionIdRaw);

    if (divisionId !== null && !Number.isFinite(divisionId)) {
      return res.status(400).json({ ok: false, error: 'invalid_division_id' });
    }

    const divisionKey = divisionId == null ? 0 : Number(divisionId);

    const { rows } = await pool.query(
      `SELECT agrupacion_id
       FROM app_user_group_favs
       WHERE business_id = $1
         AND user_id = $2
         AND scope = $3
         AND division_key = $4
       LIMIT 1`,
      [biz.id, user.id, scope, divisionKey]
    );

    const favoriteGroupId = rows.length ? Number(rows[0].agrupacion_id) : null;
    res.json({ ok: true, favoriteGroupId, scope, divisionId });
  } catch (e) {
    console.error('getFavoriteGroup error:', e);
    next(e);
  }
};

exports.saveFavoriteGroup = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const biz = req.business;
    const user = req.user;

    const { agrupacionId, scope = 'articulo', divisionId: divisionIdRaw = null } = req.body || {};

    if (!biz?.id || !user?.id) {
      return res.status(400).json({ ok: false, error: 'missing_business_or_user' });
    }

    if (!['articulo', 'insumo'].includes(scope)) {
      return res.status(400).json({ ok: false, error: 'invalid_scope' });
    }

    const divisionId =
      divisionIdRaw === null || divisionIdRaw === undefined || divisionIdRaw === ''
        ? null
        : Number(divisionIdRaw);

    if (divisionId !== null && !Number.isFinite(divisionId)) {
      return res.status(400).json({ ok: false, error: 'invalid_division_id' });
    }

    const divisionKey = divisionId == null ? 0 : Number(divisionId);
    const groupIdNum = Number(agrupacionId);

    console.log('💾 [saveFavoriteGroup]', {
      userId: user.id,
      businessId: biz.id,
      scope,
      divisionId,
      divisionKey,
      groupId: groupIdNum,
    });

    await client.query('BEGIN');

    if (!Number.isFinite(groupIdNum)) {
      await client.query(
        `DELETE FROM app_user_group_favs
         WHERE user_id = $1 
           AND business_id = $2 
           AND scope = $3 
           AND division_key = $4`,
        [user.id, biz.id, scope, divisionKey]
      );

      await client.query('COMMIT');
      console.log('✅ Favorita eliminada');
      return res.json({ ok: true, favoriteGroupId: null, scope, divisionId });
    }

    const tableName = scope === 'articulo' ? 'agrupaciones' : 'insumo_groups';
    const { rows: checkRows } = await client.query(
      `SELECT id, business_id FROM ${tableName} 
       WHERE id = $1
         AND (
           business_id = $2
           OR business_id IN (
             SELECT b2.id FROM app_businesses b2
             WHERE b2.organization_id = (
               SELECT organization_id FROM app_businesses WHERE id = $2
             )
             AND b2.created_from != 'from_group'
           )
         )
       LIMIT 1`,
      [groupIdNum, biz.id]
    );

    if (!checkRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'group_not_found' });
    }

    const realBizId = checkRows[0].business_id;

    await client.query(
      `INSERT INTO app_user_group_favs
         (user_id, business_id, agrupacion_id, scope, division_id, division_key, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id, business_id, scope, division_key)
       DO UPDATE SET
         agrupacion_id = EXCLUDED.agrupacion_id,
         division_id = EXCLUDED.division_id,
         updated_at = NOW()`,
      [user.id, realBizId, groupIdNum, scope, divisionId, divisionKey]
    );

    await client.query('COMMIT');
    console.log('✅ Favorita guardada');
    return res.json({ ok: true, favoriteGroupId: groupIdNum, scope, divisionId });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('❌ saveFavoriteGroup error:', e);
    next(e);
  } finally {
    client.release();
  }
};