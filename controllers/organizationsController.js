// controllers/organizationsController.js
const pool = require('../config/db');
const { invalidateCacheForBiz } = require('../middleware/cacheJson');
const { getEffectiveRoleOnScope, getEffectiveRole } = require('../services/auth/accessControl');

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

    // Negocio activo (del header X-Business-Id o del helper). Puede no venir.
    const activeBizId = Number(
      req.headers['x-business-id'] ||
      req.businessId ||
      req.business?.id ||
      0
    ) || null;
    console.log('[getMyOrganization] activeBizId:', activeBizId, 'header:', req.headers['x-business-id']);

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
             'props',                b.props,
             'maxi_codcli_override', b.maxi_codcli_override,
             'created_from',         b.created_from,
             'source_group_id',      b.source_group_id,
             'created_at',           b.created_at
           ) ORDER BY b.created_at ASC
         ) AS businesses,
         -- Marca 1 si esta org es la del negocio activo (para priorizarla)
         MAX(CASE WHEN b.id = $2 THEN 1 ELSE 0 END) AS es_org_activa
       FROM organizations o
       JOIN app_businesses b ON b.organization_id = o.id
       LEFT JOIN user_businesses ub ON ub.business_id = b.id AND ub.user_id = $1
       WHERE (b.owner_id = $1 OR ub.user_id IS NOT NULL)
       GROUP BY o.id
       -- 1º la org que contiene el negocio activo; luego la más reciente como fallback
       ORDER BY es_org_activa DESC, o.created_at DESC
       LIMIT 5`,
      [uid, activeBizId]
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
    const uid = req.user?.id;
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
             'props',                b.props,
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
    const uid = req.user?.id;
    const orgId = Number(req.params.orgId);
    if (!orgId) return res.status(400).json({ ok: false, error: 'invalid_org_id' });

    const hasAccess = await checkOrgAccess(orgId, uid);
    if (!hasAccess) return res.status(403).json({ ok: false, error: 'forbidden' });
    const callerRole = await getEffectiveRoleOnScope(uid, 'organization', orgId);
    if (callerRole !== 'owner') {
      return res.status(403).json({ ok: false, error: 'owner_required' });
    }
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
══════════════════════════════════════════════════════════ */
exports.createBusinessFromGroup = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const uid = req.user?.id;
    const orgId = Number(req.params.orgId);

    if (!orgId) return res.status(400).json({ ok: false, error: 'invalid_org_id' });

    const hasAccess = await checkOrgAccess(orgId, uid);
    if (!hasAccess) return res.status(403).json({ ok: false, error: 'forbidden' });

    const callerRole = await getEffectiveRoleOnScope(uid, 'organization', orgId);
    if (callerRole !== 'owner') {
      return res.status(403).json({ ok: false, error: 'owner_required' });
    }

    const {
      sourceGroupId,
      name,
      colorHex,
      maxiCodCliOverride,
      branding,
      contact,
      description,
      address,
      social,
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
      `SELECT id, nombre, articulos, app_articles_ids, business_id
         FROM agrupaciones
        WHERE id = $1 LIMIT 1`,
      [groupId]
    );

    if (!groupRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'group_not_found' });
    }

    const group = groupRows[0];
    const sourceBizId = Number(group.business_id);

    // Priorizar app_articles_ids; si está vacío, extraer IDs de articulos (objetos con {id})
    let artIds = [];
    if (Array.isArray(group.app_articles_ids) && group.app_articles_ids.length > 0) {
      artIds = group.app_articles_ids.map(Number).filter(Boolean);
    } else if (Array.isArray(group.articulos) && group.articulos.length > 0) {
      artIds = group.articulos
        .map(a => Number(a?.id ?? a))
        .filter(n => Number.isFinite(n) && n > 0);
    }

    console.log(`🏗️ [createBusinessFromGroup] Org=${orgId} | Grupo="${group.nombre}" | ${artIds.length} artículos`);
    console.log(`📋 IDs de artículos a copiar:`, artIds);

    // 2) Slug único
    const baseSlug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug = `${baseSlug}-${Date.now().toString(36)}`;

    // 3) Crear el nuevo negocio
    const propsObj = {
      branding: branding || {},
      contact: contact || {},
      address: address || {},
      social: social || {},
    };

    const { rows: bizRows } = await client.query(
      `INSERT INTO app_businesses
         (organization_id, owner_id, name, slug, color_hex, brand_logo_url,
          maxi_codcli_override, created_from, source_group_id, description, props,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, 'from_group', $7, $8, $9, NOW(), NOW())
       RETURNING *`,
      [
        orgId,
        uid,
        name.trim(),
        slug,
        colorHex || null,
        maxiCodCliOverride?.trim() || null,
        groupId,
        description?.trim() || null,
        JSON.stringify(propsObj),
      ]
    );

    const newBiz = bizRows[0];
    console.log(`✅ [createBusinessFromGroup] Nuevo negocio ID=${newBiz.id} "${newBiz.name}"`);
    // Marcar la agrupación como "movida" y vaciar sus artículos
    // (los artículos ya están en el nuevo subnegocio)
    await client.query(
      `UPDATE agrupaciones
      SET moved_to_business_id = $1,
          articulos = '[]'::jsonb,
          app_articles_ids = '[]'::jsonb,
          updated_at = NOW()
    WHERE id = $2`,
      [newBiz.id, groupId]
    );

    console.log(`📦 [createBusinessFromGroup] Agrupación ${groupId} marcada como movida a negocio ${newBiz.id}`);
    // 4) Dar acceso al usuario
    await client.query(
      `INSERT INTO user_businesses (user_id, business_id, role, created_at)
       VALUES ($1, $2, 'owner', NOW())
       ON CONFLICT (user_id, business_id) DO NOTHING`,
      [uid, newBiz.id]
    );

    // 5) Crear agrupación con el nombre de la agrupación origen en el nuevo negocio.
    // Los artículos llegan ya agrupados — el usuario no tiene que reagrupar desde cero.
    // Además crear "Sin Agrupación" vacía para que exista el espacio global.
    const { rows: sinAgrRows } = await client.query(
      `INSERT INTO agrupaciones (business_id, nombre, articulos, app_articles_ids, is_temporary, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, FALSE, NOW(), NOW())
       RETURNING id`,
      [
        newBiz.id,
        group.nombre,                                    // nombre de la agrupación origen
        JSON.stringify(artIds.map(id => ({ id }))),      // articulos como array de objetos {id}
        JSON.stringify(artIds),                          // app_articles_ids como array plano
      ]
    );
    console.log(`📁 [createBusinessFromGroup] Agrupación "${group.nombre}" ID=${sinAgrRows[0].id} con ${artIds.length} artículos`);

    // 5b) Crear "Sin Agrupación" vacía (espacio global para artículos sin agrupar)
    await client.query(
      `INSERT INTO agrupaciones (business_id, nombre, articulos, app_articles_ids, is_temporary, created_at, updated_at)
       VALUES ($1, 'Sin Agrupación', '[]'::jsonb, '[]'::jsonb, TRUE, NOW(), NOW())
       ON CONFLICT (business_id, nombre) DO NOTHING`,
      [newBiz.id]
    );

    // 6) Crear agrupación "Discontinuados" vacía en el nuevo negocio
    await client.query(
      `INSERT INTO agrupaciones (business_id, nombre, articulos, app_articles_ids, is_temporary, created_at, updated_at)
       VALUES ($1, 'Discontinuados', '[]'::jsonb, '[]'::jsonb, FALSE, NOW(), NOW())
       ON CONFLICT (business_id, nombre) DO NOTHING`,
      [newBiz.id]
    );

    // 7) Registrar relación con la agrupación origen
    await client.query(
      `INSERT INTO business_agrupaciones (business_id, agrupacion_id, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (business_id, agrupacion_id) DO NOTHING`,
      [newBiz.id, groupId]
    );

    // 8) Copiar artículos a maxi_articles del nuevo negocio
    //    (el frontend necesita estos registros para mostrar nombre, precio, categoría, etc.)
    if (artIds.length > 0) {
      await client.query(
        `INSERT INTO maxi_articles
           (business_id, articulo_id, nombre, categoria, subrubro, precio, costo, raw, updated_at)
         SELECT
           $1, articulo_id, nombre, categoria, subrubro, precio, costo, raw, NOW()
         FROM maxi_articles
         WHERE business_id = $2
           AND articulo_id = ANY($3::int[])
         ON CONFLICT (business_id, articulo_id) DO UPDATE SET
           nombre     = EXCLUDED.nombre,
           categoria  = EXCLUDED.categoria,
           subrubro   = EXCLUDED.subrubro,
           precio     = EXCLUDED.precio,
           costo      = EXCLUDED.costo,
           raw        = EXCLUDED.raw,
           updated_at = NOW()`,
        [newBiz.id, sourceBizId, artIds]
      );
      console.log(`📦 [createBusinessFromGroup] maxi_articles copiados al negocio ${newBiz.id}`);

      // 9) Copiar también maxi_article_map
      await client.query(
        `INSERT INTO maxi_article_map
           (business_id, articulo_id, categoria, subrubro, external_code, title, updated_at)
         SELECT
           $1, articulo_id, categoria, subrubro, external_code, title, NOW()
         FROM maxi_article_map
         WHERE business_id = $2
           AND articulo_id = ANY($3::int[])
         ON CONFLICT (business_id, articulo_id) DO UPDATE SET
           categoria     = EXCLUDED.categoria,
           subrubro      = EXCLUDED.subrubro,
           external_code = EXCLUDED.external_code,
           title         = EXCLUDED.title,
           updated_at    = NOW()`,
        [newBiz.id, sourceBizId, artIds]
      );
      console.log(`🗺️  [createBusinessFromGroup] maxi_article_map copiados al negocio ${newBiz.id}`);
    }

    await client.query('COMMIT');

    // Invalidar caché del negocio principal y del nuevo subnegocio
    invalidateCacheForBiz(sourceBizId);
    invalidateCacheForBiz(newBiz.id);
    console.log(`🗑️  [createBusinessFromGroup] Caché invalidada para negocio ${sourceBizId} y ${newBiz.id}`);

    return res.status(201).json({
      ok: true,
      business: {
        ...newBiz,
        articulos_count: artIds.length,
        sin_agrupacion_id: sinAgrRows[0].id,
      },
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[createBusinessFromGroup]', e);
    next(e);
  } finally {
    client.release();
  }
};

/* ══════════════════════════════════════════════════════════
   POST /api/organizations
   Onboarding: crear organización y vincularla a un negocio existente
══════════════════════════════════════════════════════════ */
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

    // Verificar acceso al negocio
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

    const callerRoleOnBiz = await getEffectiveRole(uid, bizId);
    if (callerRoleOnBiz !== 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({ ok: false, error: 'owner_required' });
    }

    if (bizCheck[0].organization_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        ok: false,
        error: 'business_already_has_org',
        organization_id: bizCheck[0].organization_id,
      });
    }

    // Crear organización
    const { rows: orgRows } = await client.query(
      `INSERT INTO organizations (name, display_name, created_by, created_at, updated_at)
       VALUES ($1, $1, $2, NOW(), NOW())
       RETURNING *`,
      [name.trim(), uid]
    );
    const org = orgRows[0];
    console.log(`✅ [createOrganization] Org creada ID=${org.id} "${org.name}"`);

    // Vincular negocio a la org
    await client.query(
      `UPDATE app_businesses SET organization_id = $1 WHERE id = $2`,
      [org.id, bizId]
    );
    console.log(`✅ [createOrganization] Business ${bizId} vinculado a org ${org.id}`);

    // Crear agrupaciones especiales
    const ensureSpecialGroup = async (nombre) => {
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

      const { rows: inserted } = await client.query(
        `INSERT INTO agrupaciones (business_id, nombre, articulos, created_at, updated_at)
         VALUES ($1, $2, '[]'::jsonb, NOW(), NOW())
         RETURNING id`,
        [bizId, nombre]
      );
      console.log(`   ✅ "${nombre}" creada: ID=${inserted[0].id}`);
      return inserted[0].id;
    };

    const sinAgrupId = await ensureSpecialGroup('Sin Agrupación');
    const discontinId = await ensureSpecialGroup('Discontinuados');

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
      console.log(`✅ [createOrganization] Special groups registradas`);
    } catch (eTable) {
      console.warn('[createOrganization] ⚠️  organization_special_groups no existe:', eTable.message);
    }

    await client.query('COMMIT');
    console.log(`🎉 [createOrganization] COMMIT exitoso`);

    return res.status(201).json({ ok: true, organization: org });

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[createOrganization] ❌ ERROR:', e);
    next(e);
  } finally {
    client.release();
  }
};