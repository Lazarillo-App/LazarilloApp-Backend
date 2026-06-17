// controllers/meController.js
//
// Endpoints de "yo" — info del usuario logueado en cuanto a accesos y roles.

const pool = require('../config/db');
const { listAccessibleBusinesses } = require('../services/auth/accessControl');

/* ════════════════════════════════════════════════════════════════════
   GET /api/me/access
   Devuelve:
     - businesses: lista de negocios accesibles con rol efectivo, alias,
                   nombre del negocio y org a la que pertenece (si aplica)
     - organizations: lista de orgs donde el usuario tiene assignment
     - active_business_id (el guardado en app_users)
═════════════════════════════════════════════════════════════════════ */
exports.getAccess = async (req, res, next) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ ok: false, error: 'unauthorized' });

    // Negocios accesibles (vía owner_id, assignment business, o assignment org expandido)
    const raw = await listAccessibleBusinesses(uid);

    // Dedup por business_id quedándose con el rol más alto + datos de un solo source
    const ROLE_LEVEL = { owner: 3, admin: 2, staff: 1 };
    const byBiz = new Map();
    for (const r of raw) {
      const cur = byBiz.get(r.business_id);
      if (!cur || (ROLE_LEVEL[r.role] ?? 0) > (ROLE_LEVEL[cur.role] ?? 0)) {
        byBiz.set(r.business_id, r);
      }
    }
    const bizIds = Array.from(byBiz.keys()).map(Number);

    // Hidratar con datos del negocio
    let businesses = [];
    if (bizIds.length) {
      const { rows } = await pool.query(
        `SELECT b.id, b.name, b.slug, b.color_hex, b.brand_logo_url,
                b.organization_id, b.created_from, b.source_group_id,
                o.name AS organization_name
           FROM app_businesses b
           LEFT JOIN organizations o ON o.id = b.organization_id
          WHERE b.id = ANY($1::bigint[])`,
        [bizIds]
      );
      businesses = rows.map(b => {
        const r = byBiz.get(String(b.id)) || byBiz.get(b.id);
        return {
          id: Number(b.id),
          name: b.name,
          slug: b.slug,
          color_hex: b.color_hex,
          brand_logo_url: b.brand_logo_url,
          organization_id: b.organization_id ? Number(b.organization_id) : null,
          organization_name: b.organization_name,
          created_from: b.created_from,
          source_group_id: b.source_group_id ? Number(b.source_group_id) : null,
          role: r?.role || null,
          source: r?.source || null,
          alias: r?.alias || null,
        };
      });

      // Orden estable: orgs juntos por org, luego standalone, por created_at proxy (id asc)
      businesses.sort((a, b) => {
        const oa = a.organization_id || 999999999;
        const ob = b.organization_id || 999999999;
        if (oa !== ob) return oa - ob;
        return a.id - b.id;
      });
    }

    // Orgs donde tengo assignment directo (no contar las que llegan por owner_id de un biz)
    const { rows: orgRows } = await pool.query(
      `SELECT o.id, o.name, o.display_name, ua.role, ua.alias
         FROM user_assignments ua
         JOIN organizations o ON o.id = ua.scope_id
        WHERE ua.user_id = $1
          AND ua.scope_type = 'organization'
          AND ua.revoked_at IS NULL`,
      [uid]
    );

    // active_business_id guardado
    const { rows: u } = await pool.query(
      `SELECT active_business_id, name, email FROM app_users WHERE id = $1`,
      [uid]
    );
    const active = u[0]?.active_business_id ? Number(u[0].active_business_id) : null;

    // Validar que el active_business_id sigue siendo accesible; si no, sugerir el primero
    const accessibleIds = new Set(businesses.map(b => b.id));
    const validActive = active && accessibleIds.has(active) ? active : null;
    const suggestedActive = validActive || (businesses[0]?.id ?? null);

    return res.json({
      ok: true,
      user: { id: uid, name: u[0]?.name || null, email: u[0]?.email || null },
      businesses,
      organizations: orgRows,
      active_business_id: validActive,
      suggested_active_business_id: suggestedActive,
      needs_selector: businesses.length > 1 && !validActive,
    });
  } catch (e) {
    console.error('[getAccess]', e);
    next(e);
  }
};

/* ════════════════════════════════════════════════════════════════════
   POST /api/me/active-business
   body: { businessId }
   Setea el active_business_id si el usuario tiene acceso.
═════════════════════════════════════════════════════════════════════ */
exports.setActiveBusiness = async (req, res, next) => {
  try {
    const uid = req.user?.id;
    const bizId = Number(req.body?.businessId);
    if (!uid) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!Number.isFinite(bizId)) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    // Verificar acceso
    const accessible = await listAccessibleBusinesses(uid);
    const hasAccess = accessible.some(r => Number(r.business_id) === bizId);
    if (!hasAccess) return res.status(403).json({ ok: false, error: 'forbidden' });

    await pool.query(
      `UPDATE app_users SET active_business_id = $1, updated_at = NOW() WHERE id = $2`,
      [bizId, uid]
    );

    return res.json({ ok: true, active_business_id: bizId });
  } catch (e) {
    console.error('[setActiveBusiness]', e);
    next(e);
  }
};