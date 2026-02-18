// controllers/organizationsController.js (CORREGIDO según feedback PDF)
const pool = require('../config/db');

/* ══════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════ */

async function checkOrgAccess(orgId, userId) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM organizations o
       JOIN app_businesses b ON b.organization_id = o.id
       LEFT JOIN user_businesses ub ON ub.business_id = b.id AND ub.user_id = $2
      WHERE o.id = $1
        AND (b.owner_id = $2 OR ub.user_id IS NOT NULL)
      LIMIT 1`,
    [orgId, userId]
  );
  return rows.length > 0;
}

/* ══════════════════════════════════════════════════════════
   GET /api/me/organization
══════════════════════════════════════════════════════════ */
exports.getMyOrganization = async (req, res, next) => {
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const { rows } = await pool.query(
      `SELECT
         o.id,
         o.name,
         o.display_name,
         o.maxi_codcli,
         o.settings,
         o.created_at,
         o.updated_at,
         json_agg(
           json_build_object(
             'id',                   b.id,
             'name',                 b.name,
             'slug',                 b.slug,
             'color_hex',            b.color_hex,
             'brand_logo_url',       b.brand_logo_url,
             'maxi_codcli_override', b.maxi_codcli_override,
             'created_from',         b.created_from,
             'source_group_id',      b.source_group_id,
             'created_at',           b.created_at
           ) ORDER BY b.created_at ASC
         ) AS businesses
       FROM app_users u
       JOIN app_businesses ab ON ab.id = u.active_business_id
       JOIN organizations o   ON o.id  = ab.organization_id
       JOIN app_businesses b  ON b.organization_id = o.id
       LEFT JOIN user_businesses ub ON ub.business_id = b.id AND ub.user_id = $1
       WHERE u.id = $1
         AND (b.owner_id = $1 OR ub.user_id IS NOT NULL)
       GROUP BY o.id`,
      [uid]
    );

    return res.json({ ok: true, organization: rows[0] || null });
  } catch (e) {
    console.error('[getMyOrganization]', e);
    next(e);
  }
};

/* ══════════════════════════════════════════════════════════
   GET /api/organizations/:orgId
══════════════════════════════════════════════════════════ */
exports.getOrganization = async (req, res, next) => {
  try {
    const uid   = req.user?.id;
    const orgId = Number(req.params.orgId);
    if (!orgId) return res.status(400).json({ ok: false, error: 'invalid_org_id' });

    const hasAccess = await checkOrgAccess(orgId, uid);
    if (!hasAccess) return res.status(403).json({ ok: false, error: 'forbidden' });

    const { rows } = await pool.query(
      `SELECT
         o.id, o.name, o.display_name, o.maxi_codcli, o.settings,
         o.created_at, o.updated_at,
         json_agg(
           json_build_object(
             'id',                   b.id,
             'name',                 b.name,
             'slug',                 b.slug,
             'color_hex',            b.color_hex,
             'brand_logo_url',       b.brand_logo_url,
             'maxi_codcli_override', b.maxi_codcli_override,
             'created_from',         b.created_from,
             'source_group_id',      b.source_group_id,
             'created_at',           b.created_at
           ) ORDER BY b.created_at ASC
         ) AS businesses
       FROM organizations o
       JOIN app_businesses b ON b.organization_id = o.id
       WHERE o.id = $1
       GROUP BY o.id`,
      [orgId]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: 'org_not_found' });

    return res.json({ ok: true, organization: rows[0] });
  } catch (e) {
    console.error('[getOrganization]', e);
    next(e);
  }
};

/* ══════════════════════════════════════════════════════════
   PATCH /api/organizations/:orgId
══════════════════════════════════════════════════════════ */
exports.updateOrganization = async (req, res, next) => {
  try {
    const uid   = req.user?.id;
    const orgId = Number(req.params.orgId);
    if (!orgId) return res.status(400).json({ ok: false, error: 'invalid_org_id' });

    const hasAccess = await checkOrgAccess(orgId, uid);
    if (!hasAccess) return res.status(403).json({ ok: false, error: 'forbidden' });

    const { name, display_name, maxi_codcli } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ ok: false, error: 'name_required' });

    const { rows } = await pool.query(
      `UPDATE organizations
          SET name         = $1,
              display_name = $2,
              maxi_codcli  = $3,
              updated_at   = NOW()
        WHERE id = $4
        RETURNING id, name, display_name, maxi_codcli, updated_at`,
      [name.trim(), display_name?.trim() || null, maxi_codcli?.trim() || null, orgId]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: 'org_not_found' });

    return res.json({ ok: true, organization: rows[0] });
  } catch (e) {
    console.error('[updateOrganization]', e);
    next(e);
  }
};

/* ══════════════════════════════════════════════════════════
   POST /api/organizations/:orgId/businesses/from-group
   
   CAMBIO CRÍTICO según feedback PDF:
   - Los artículos llegan a "Sin Agrupación" del SUB-NEGOCIO
   - Esta "Sin Agrupación" es TEMPORAL (is_temporary = true)
   - Una vez que el usuario los organiza → desaparece
   - NO es la "Sin Agrupación" global de la organización
══════════════════════════════════════════════════════════ */
exports.createBusinessFromGroup = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const uid   = req.user?.id;
    const orgId = Number(req.params.orgId);

    if (!orgId) return res.status(400).json({ ok: false, error: 'invalid_org_id' });

    const hasAccess = await checkOrgAccess(orgId, uid);
    if (!hasAccess) return res.status(403).json({ ok: false, error: 'forbidden' });

    const {
      sourceGroupId,
      name,
      colorHex,
      maxiCodCliOverride,
    } = req.body || {};

    if (!sourceGroupId || !Number.isFinite(Number(sourceGroupId))) {
      return res.status(400).json({ ok: false, error: 'source_group_id_required' });
    }
    if (!name?.trim()) {
      return res.status(400).json({ ok: false, error: 'name_required' });
    }

    const groupId = Number(sourceGroupId);

    await client.query('BEGIN');

    // 1) Obtener agrupación origen con sus artículos
    const { rows: groupRows } = await client.query(
      `SELECT id, nombre, articulos, business_id
         FROM agrupaciones
        WHERE id = $1 LIMIT 1`,
      [groupId]
    );

    if (!groupRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'group_not_found' });
    }

    const group  = groupRows[0];
    const artIds = Array.isArray(group.articulos)
      ? group.articulos.map(Number).filter(Boolean)
      : [];

    console.log(`🏗️ [createBusinessFromGroup] Org=${orgId} | Grupo="${group.nombre}" | ${artIds.length} artículos`);

    // 2) Slug único
    const baseSlug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug     = `${baseSlug}-${Date.now().toString(36)}`;

    // 3) Crear el nuevo negocio (SIN parent_id, todos son hermanos)
    const { rows: bizRows } = await client.query(
      `INSERT INTO app_businesses
         (organization_id, owner_id, name, slug, color_hex, brand_logo_url,
          maxi_codcli_override, created_from, source_group_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, 'from_group', $7, NOW(), NOW())
       RETURNING *`,
      [orgId, uid, name.trim(), slug, colorHex || null, maxiCodCliOverride?.trim() || null, groupId]
    );

    const newBiz = bizRows[0];
    console.log(`✅ [createBusinessFromGroup] Nuevo negocio ID=${newBiz.id} "${newBiz.name}"`);

    // 4) Dar acceso al usuario
    await client.query(
      `INSERT INTO user_businesses (user_id, business_id, role, created_at)
       VALUES ($1, $2, 'owner', NOW())
       ON CONFLICT (user_id, business_id) DO NOTHING`,
      [uid, newBiz.id]
    );

    // 5) Crear agrupación "Sin Agrupación" TEMPORAL en el nuevo negocio
    //    con todos los artículos de la agrupación origen
    const sinAgrupacionNombre = 'Sin Agrupación';
    const { rows: sinAgrRows } = await client.query(
      `INSERT INTO agrupaciones (business_id, nombre, articulos, is_temporary, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, TRUE, NOW(), NOW())
       RETURNING id`,
      [newBiz.id, sinAgrupacionNombre, JSON.stringify(artIds)]
    );

    console.log(`📁 [createBusinessFromGroup] "Sin Agrupación" temporal ID=${sinAgrRows[0].id} con ${artIds.length} artículos`);

    // 6) Registrar en business_agrupaciones la agrupación origen
    await client.query(
      `INSERT INTO business_agrupaciones (business_id, agrupacion_id, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (business_id, agrupacion_id) DO NOTHING`,
      [newBiz.id, groupId]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      ok: true,
      business: {
        ...newBiz,
        articulos_count: artIds.length,
        sin_agrupacion_id: sinAgrRows[0].id,
      },
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[createBusinessFromGroup]', e);
    next(e);
  } finally {
    client.release();
  }
};

// ══════════════════════════════════════════════════════════
// POST /api/organizations
// FIX FINAL: NO usa ensure_org_special_groups() porque esa función
// intenta insertar con business_id = NULL.
// 
// Solución: crear las agrupaciones especiales ANCLADAS al bizId
// directamente en el controller.
// ══════════════════════════════════════════════════════════
exports.createOrganization = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const uid = req.user?.id;
    if (!uid) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const { name, businessId, maxiCodCli } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ ok: false, error: 'name_required' });

    const bizId = Number(businessId);
    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'business_id_required' });
    }

    await client.query('BEGIN');

    // 1) Verificar acceso al negocio
    const { rows: bizCheck } = await client.query(
      `SELECT id, organization_id FROM app_businesses
        WHERE id = $1
          AND (owner_id = $2 OR id IN (
            SELECT business_id FROM user_businesses WHERE user_id = $2
          ))
        LIMIT 1`,
      [bizId, uid]
    );

    if (!bizCheck.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ ok: false, error: 'forbidden_or_not_found' });
    }

    if (bizCheck[0].organization_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        ok: false,
        error: 'business_already_has_org',
        organization_id: bizCheck[0].organization_id,
      });
    }

    // 2) Crear organización
    const { rows: orgRows } = await client.query(
      `INSERT INTO organizations (name, display_name, created_by, created_at, updated_at)
       VALUES ($1, $1, $2, NOW(), NOW())
       RETURNING *`,
      [name.trim(), uid]
    );
    const org = orgRows[0];

    console.log(`✅ [createOrganization] Org creada ID=${org.id} "${org.name}"`);

    // 3) Vincular negocio a la org
    await client.query(
      `UPDATE app_businesses SET organization_id = $1 WHERE id = $2`,
      [org.id, bizId]
    );

    console.log(`✅ [createOrganization] Business ${bizId} vinculado a org ${org.id}`);

    // 4) Crear agrupaciones especiales ANCLADAS al bizId (NO NULL)
    const ensureSpecialGroup = async (nombre) => {
      // Verificar si ya existe
      const { rows: existing } = await client.query(
        `SELECT id FROM agrupaciones
          WHERE business_id = $1 AND LOWER(nombre) = LOWER($2)
          LIMIT 1`,
        [bizId, nombre]
      );

      if (existing.length) {
        console.log(`   ℹ️  "${nombre}" ya existe: ID=${existing[0].id}`);
        return existing[0].id;
      }

      // Crear nueva
      const { rows: inserted } = await client.query(
        `INSERT INTO agrupaciones (business_id, nombre, articulos, created_at, updated_at)
         VALUES ($1, $2, '[]'::jsonb, NOW(), NOW())
         RETURNING id`,
        [bizId, nombre]
      );

      console.log(`   ✅ "${nombre}" creada: ID=${inserted[0].id}`);
      return inserted[0].id;
    };

    const sinAgrupId  = await ensureSpecialGroup('Sin Agrupación');
    const discontinId = await ensureSpecialGroup('Discontinuados');

    // 5) Registrar en organization_special_groups (si la tabla existe)
    try {
      await client.query(
        `INSERT INTO organization_special_groups
           (organization_id, sin_agrupacion_id, discontinuados_id, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (organization_id) DO UPDATE SET
           sin_agrupacion_id = COALESCE(EXCLUDED.sin_agrupacion_id, organization_special_groups.sin_agrupacion_id),
           discontinuados_id = COALESCE(EXCLUDED.discontinuados_id, organization_special_groups.discontinuados_id),
           updated_at = NOW()`,
        [org.id, sinAgrupId, discontinId]
      );
      console.log(`✅ [createOrganization] Special groups registradas en organization_special_groups`);
    } catch (eTable) {
      // Si la tabla no existe en prod, no bloquear
      console.warn('[createOrganization] ⚠️  organization_special_groups no existe o falló:', eTable.message);
    }

    await client.query('COMMIT');
    console.log(`🎉 [createOrganization] COMMIT exitoso`);

    return res.status(201).json({ ok: true, organization: org });

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[createOrganization] ❌ ERROR:', e);
    console.error('[createOrganization] Stack:', e.stack);
    next(e);
  } finally {
    client.release();
  }
};