// controllers/articulosABMController.js
// Alta, baja y modificación manual de artículos desde Lazarillo
'use strict';

const pool = require('../config/db');
const { invalidateCacheForBiz } = require('../middleware/cacheJson');

function getBusinessId(req) {
  const ctx = Number(req.businessId);
  if (Number.isFinite(ctx)) return ctx;
  const p = Number(req.params?.businessId ?? req.params?.id);
  if (Number.isFinite(p)) return p;
  const h = Number(req.header('X-Business-Id'));
  if (Number.isFinite(h)) return h;
  return NaN;
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resuelve dónde "físicamente" viven los artículos para un business.
 * Para subnegocios (con organization_id), devuelve el principal de la org.
 * Para principales o standalone, devuelve el mismo bizId.
 */
async function resolveStorageBizId(bizId) {
  const { rows } = await pool.query(
    `SELECT organization_id FROM app_businesses WHERE id = $1`, [bizId]
  );
  if (!rows[0]?.organization_id) return bizId;
  const { rows: pRows } = await pool.query(
    `SELECT id FROM app_businesses
      WHERE organization_id = $1 AND created_from != 'from_group'
      ORDER BY created_at ASC LIMIT 1`,
    [rows[0].organization_id]
  );
  return pRows[0]?.id ? Number(pRows[0].id) : bizId;
}

// ─────────────────────────────────────────────────────────────
// GET /businesses/:id/rubros
// Devuelve categorias + subrubros del negocio (de app_articles)
// ─────────────────────────────────────────────────────────────
exports.getRubros = async (req, res, next) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) return res.status(400).json({ ok: false, error: 'businessId inválido' });

    // 🆕 Resolver storage (principal de la org si bizId es subnegocio)
    const storageBizId = await resolveStorageBizId(bizId);
    const isSubnegocio = storageBizId !== bizId;

    // Leer flag de jerarquía del principal (el catálogo vive ahí)
    const { rows: bizRows } = await pool.query(
      `SELECT props FROM app_businesses WHERE id = $1`, [storageBizId]
    );
    const invertir = bizRows[0]?.props?.invertir_jerarquia_articulos === true;

    // 🆕 Si bizId es subnegocio, restringir a rubros de artículos asignados a sus agrupaciones reales
    let articleIdFilter = null; // null = sin filtro (todos del principal)
    if (isSubnegocio) {
      const { rows: subAgRows } = await pool.query(
        `SELECT articulos, app_articles_ids
           FROM agrupaciones
          WHERE business_id = $1
            AND nombre NOT ILIKE 'Sin Agrupac%'
            AND nombre NOT ILIKE 'Sin Agrupar%'
            AND nombre NOT ILIKE 'Discontinuados'
            AND nombre NOT ILIKE 'Descontinuados'`,
        [bizId]
      );
      const ids = new Set();
      for (const ag of subAgRows) {
        const arts = Array.isArray(ag.articulos) ? ag.articulos
          : (typeof ag.articulos === 'string' ? JSON.parse(ag.articulos || '[]') : []);
        const appIds = Array.isArray(ag.app_articles_ids) ? ag.app_articles_ids
          : (typeof ag.app_articles_ids === 'string' ? JSON.parse(ag.app_articles_ids || '[]') : []);
        for (const a of arts) {
          const n = Number(a?.id ?? a?.articulo_id ?? a);
          if (Number.isFinite(n) && n !== 0) ids.add(n);
        }
        for (const raw of appIds) {
          const n = Number(raw);
          if (Number.isFinite(n) && n !== 0) ids.add(n);
        }
      }
      // Si el subnegocio tiene artículos asignados, filtrar. Si está vacío,
      // fallback a todo el catálogo del principal (para poder crear el primer artículo).
      if (ids.size > 0) articleIdFilter = Array.from(ids);
    }

    const params = [storageBizId];
    let extraWhere = '';
    if (articleIdFilter) {
      params.push(articleIdFilter);
      extraWhere = ` AND articulo_id = ANY($2::int[])`;
    }

    const { rows } = await pool.query(
      `SELECT DISTINCT
         COALESCE(subrubro,  '') AS col_rubro,
         COALESCE(categoria, '') AS col_subrubro
       FROM maxi_articles
       WHERE business_id = $1
         ${extraWhere}
         AND subrubro IS NOT NULL
         AND subrubro != ''
         AND subrubro NOT ILIKE '%pendiente%'
       ORDER BY 1, 2`,
      params
    );

    // Sin invertir: rubro=categoria, subrubro=subrubro
    // Con invertir: rubro=subrubro (col_rubro), subrubro=categoria (col_subrubro)
    const byCategoria = {};
    for (const row of rows) {
      const cat = (invertir ? row.col_rubro : row.col_subrubro) || 'Sin rubro';
      const sub = invertir ? row.col_subrubro : row.col_rubro;
      if (!byCategoria[cat]) byCategoria[cat] = [];
      if (sub && !sub.includes('[PENDIENTE]') && sub !== '') {
        byCategoria[cat].push(sub);
      }
    }

    const categorias = Object.entries(byCategoria).map(([nombre, subrubros]) => ({
      nombre,
      subrubros: [...new Set(subrubros)].sort(),
    }));

    return res.json({ ok: true, categorias });
  } catch (e) {
    console.error('[getRubros]', e.message);
    next(e);
  }
};

// ─────────────────────────────────────────────────────────────
// POST /businesses/:id/articles
// Crea un artículo manual con id negativo secuencial
// Body: { nombre, rubro, subrubro, precio, agrupacionId? }
// ─────────────────────────────────────────────────────────────
exports.crearArticulo = async (req, res, next) => {
  const bizId = getBusinessId(req);
  if (!Number.isFinite(bizId)) return res.status(400).json({ ok: false, error: 'businessId inválido' });

  const { nombre, rubro, subrubro, precio, agrupacionId } = req.body || {};

  if (!nombre?.trim()) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
  if (!rubro?.trim()) return res.status(400).json({ ok: false, error: 'Rubro requerido' });

  // 🆕 RESOLVER NEGOCIO DE ALMACENAMIENTO (Opción B)
  // Si bizId es subnegocio (tiene organization_id), los artículos físicamente
  // viven en el principal de la org. El subnegocio solo los "ve" via agrupaciones.
  const { rows: bizRows } = await pool.query(
    `SELECT props, organization_id FROM app_businesses WHERE id = $1`, [bizId]
  );
  if (!bizRows.length) return res.status(404).json({ ok: false, error: 'Negocio no encontrado' });

  let storageBizId = bizId;
  if (bizRows[0].organization_id) {
    const { rows: pRows } = await pool.query(
      `SELECT id FROM app_businesses
        WHERE organization_id = $1 AND created_from != 'from_group'
        ORDER BY created_at ASC LIMIT 1`,
      [bizRows[0].organization_id]
    );
    if (pRows[0]?.id) storageBizId = Number(pRows[0].id);
  }

  // Leer flag de jerarquía invertida del negocio de almacenamiento (el principal)
  const { rows: storageBizRows } = await pool.query(
    `SELECT props FROM app_businesses WHERE id = $1`, [storageBizId]
  );
  const invertir = storageBizRows[0]?.props?.invertir_jerarquia_articulos === true;

  // Con jerarquía invertida: el "rubro" que ve el usuario va en subrubro de maxi_articles
  // y el "subrubro" va en categoria — porque el árbol lee subrubro→categoria
  const maxiCategoria = invertir ? (subrubro?.trim() || null) : rubro.trim();
  const maxiSubrubro = invertir ? rubro.trim() : (subrubro?.trim() || null);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('[crearArticulo] body:', JSON.stringify({ nombre, rubro, subrubro, precio, invertir }));

    // ID negativo secuencial para artículos manuales (no interfiere con IDs de Maxi)
    // Usamos FOR UPDATE para evitar race conditions y buscamos globalmente (no solo por biz)
    const { rows: minRows } = await client.query(
      `SELECT COALESCE(MIN(id), 0) - 1 AS next_id
         FROM app_articles
        WHERE id < 0`
    );
    const newId = Math.min(minRows[0].next_id, -1);
    console.log('[crearArticulo] newId calculado:', newId);

    // Buscar o crear categoria_id
    let { rows: catRows } = await client.query(
      `SELECT id FROM categorias WHERE nombre = $1`, [rubro.trim()]
    );
    let categoriaId;
    if (catRows.length) {
      categoriaId = catRows[0].id;
    } else {
      const ins = await client.query(
        `INSERT INTO categorias (nombre) VALUES ($1) RETURNING id`, [rubro.trim()]
      );
      categoriaId = ins.rows[0].id;
    }

    // Buscar o crear subrubro_id
    let subrubroId = 1;
    if (subrubro?.trim()) {
      let { rows: subRows } = await client.query(
        `SELECT id FROM subrubros WHERE categoria_id = $1 AND nombre = $2`,
        [categoriaId, subrubro.trim()]
      );
      if (subRows.length) {
        subrubroId = subRows[0].id;
      } else {
        const ins = await client.query(
          `INSERT INTO subrubros (categoria_id, nombre) VALUES ($1, $2) RETURNING id`,
          [categoriaId, subrubro.trim()]
        );
        subrubroId = ins.rows[0].id;
      }
    }

    // SKU provisorio: L-BIZ-ID (cuando llegue equivalencia externa se pisa)
    // SKU formato L001, L002, ... L999, L1000 — padding a 3 dígitos mínimo
    const numStr = String(Math.abs(newId)).padStart(3, '0');
    const skuProvisorio = `L${numStr}`;

    // Insertar el artículo
    // Insertar el artículo (en el principal si bizId es subnegocio)
    const { rows: artRows } = await client.query(
      `INSERT INTO app_articles
         (id, business_id, name, rubro, subrubro, node_type, price, categoria_id, subrubro_id, props, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'item', $6, $7, $8, $9, NOW())
       RETURNING *`,
      [
        newId,
        storageBizId,  // 🆕 principal de la org, no el subnegocio
        nombre.trim(),
        rubro.trim(),
        subrubro?.trim() || null,
        safeNum(precio) ?? 0,
        categoriaId,
        subrubroId,
        JSON.stringify({ origen: 'manual', sku: skuProvisorio, sin_equivalencia: true }),
      ]
    );

    const articulo = artRows[0];

    // Insertar también en maxi_articles con origen='manual' para que aparezca en el árbol
    // y sea distinguible (se muestra como L{id} en la UI hasta que llegue la sync de MaxiRest)
    const manualBatchId = `manual-abm-${new Date().toISOString().slice(0, 10)}`;
    await client.query(
      `INSERT INTO maxi_articles
         (business_id, articulo_id, nombre, categoria, subrubro, precio, costo, raw, origen, upload_batch_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, '{}'::jsonb, 'manual', $7, NOW())
       ON CONFLICT (business_id, articulo_id) DO UPDATE SET
         nombre          = EXCLUDED.nombre,
         categoria       = EXCLUDED.categoria,
         subrubro        = EXCLUDED.subrubro,
         precio          = EXCLUDED.precio,
         origen          = COALESCE(maxi_articles.origen, 'manual'),
         upload_batch_id = COALESCE(maxi_articles.upload_batch_id, EXCLUDED.upload_batch_id),
         updated_at      = NOW()`,
      [storageBizId, newId, nombre.trim(), maxiCategoria, maxiSubrubro, safeNum(precio) ?? 0, manualBatchId]
    );

    // Si viene agrupacionId, agregar el artículo a esa agrupación
    if (agrupacionId) {
      try {
        // Buscar la agrupación y agregar el id al array articulos
        const { rows: agRows } = await client.query(
          `SELECT id, articulos, app_articles_ids FROM agrupaciones WHERE id = $1 AND business_id = $2`,
          [agrupacionId, bizId]
        );
        if (agRows.length) {
          const ag = agRows[0];
          const articulos = Array.isArray(ag.articulos) ? ag.articulos
            : (typeof ag.articulos === 'string' ? JSON.parse(ag.articulos || '[]') : []);
          const appIds = Array.isArray(ag.app_articles_ids) ? ag.app_articles_ids
            : (typeof ag.app_articles_ids === 'string' ? JSON.parse(ag.app_articles_ids || '[]') : []);

          articulos.push({ id: newId, nombre: nombre.trim(), precio: safeNum(precio) ?? 0 });
          appIds.push(newId);

          await client.query(
            `UPDATE agrupaciones SET articulos = $1, app_articles_ids = $2, updated_at = NOW()
               WHERE id = $3`,
            [JSON.stringify(articulos), JSON.stringify(appIds), agrupacionId]
          );
        }
      } catch (agErr) {
        console.warn('[crearArticulo] Error al agregar a agrupación:', agErr.message);
        // No crítico — el artículo se crea igual
      }
    }

    await client.query('COMMIT');

    // Invalidar caché del tree/articles para que el manual aparezca inmediatamente
    invalidateCacheForBiz(bizId);
    if (storageBizId !== bizId) invalidateCacheForBiz(storageBizId);

    console.log(`[crearArticulo] Artículo manual creado: id=${newId} "${nombre}" biz=${bizId}`);
    return res.status(201).json({ ok: true, articulo, sku: skuProvisorio });

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[crearArticulo]', e.message);
    next(e);
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────
// PATCH /businesses/:id/articles/:articleId
// Actualiza campos de un artículo (manual o con equivalencia)
// Body: { nombre?, rubro?, subrubro?, precio?, codigoExterno? }
// ─────────────────────────────────────────────────────────────
exports.actualizarArticulo = async (req, res, next) => {
  const bizId = getBusinessId(req);
  const articleId = Number(req.params.articleId);
  if (!Number.isFinite(bizId) || !Number.isFinite(articleId)) {
    return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
  }

  const { nombre, rubro, subrubro, precio, codigoExterno } = req.body || {};

  // 🆕 Si bizId es subnegocio, el artículo vive en el principal
  const storageBizId = await resolveStorageBizId(bizId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM app_articles WHERE id = $1 AND business_id = $2`, [articleId, storageBizId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Artículo no encontrado' });
    }

    const art = rows[0];
    const sets = [];
    const vals = [];
    let pi = 1;

    if (nombre?.trim()) { sets.push(`name = $${pi++}`); vals.push(nombre.trim()); }
    if (precio != null) { sets.push(`price = $${pi++}`); vals.push(safeNum(precio) ?? 0); }

    // Rubro/subrubro — buscar o crear categoría
    let categoriaId = art.categoria_id;
    let subrubroId = art.subrubro_id;

    if (rubro?.trim() && rubro.trim() !== art.rubro) {
      let { rows: catRows } = await client.query(
        `SELECT id FROM categorias WHERE nombre = $1`, [rubro.trim()]
      );
      if (catRows.length) {
        categoriaId = catRows[0].id;
      } else {
        const ins = await client.query(
          `INSERT INTO categorias (nombre) VALUES ($1) RETURNING id`, [rubro.trim()]
        );
        categoriaId = ins.rows[0].id;
      }
      sets.push(`rubro = $${pi++}`); vals.push(rubro.trim());
      sets.push(`categoria_id = $${pi++}`); vals.push(categoriaId);
      subrubroId = 1; // reset subrubro si cambió el rubro
    }

    if (subrubro?.trim() && subrubro.trim() !== art.subrubro) {
      let { rows: subRows } = await client.query(
        `SELECT id FROM subrubros WHERE categoria_id = $1 AND nombre = $2`,
        [categoriaId, subrubro.trim()]
      );
      if (subRows.length) {
        subrubroId = subRows[0].id;
      } else {
        const ins = await client.query(
          `INSERT INTO subrubros (categoria_id, nombre) VALUES ($1, $2) RETURNING id`,
          [categoriaId, subrubro.trim()]
        );
        subrubroId = ins.rows[0].id;
      }
      sets.push(`subrubro = $${pi++}`); vals.push(subrubro.trim());
      sets.push(`subrubro_id = $${pi++}`); vals.push(subrubroId);
    }

    // Código externo — actualiza SKU y quita sin_equivalencia
    if (codigoExterno?.trim()) {
      const props = art.props || {};
      const skuFinal = `L${codigoExterno.trim()}`;
      props.sku = skuFinal;
      props.codigo_externo = codigoExterno.trim();
      props.sin_equivalencia = false;
      sets.push(`props = $${pi++}`);
      vals.push(JSON.stringify(props));
    }

    if (!sets.length) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, articulo: art, message: 'Sin cambios' });
    }

    sets.push(`updated_at = NOW()`);
    vals.push(articleId, storageBizId);  // 🆕

    const { rows: updated } = await client.query(
      `UPDATE app_articles SET ${sets.join(', ')}
        WHERE id = $${pi++} AND business_id = $${pi}
       RETURNING *`,
      vals
    );

    await client.query('COMMIT');

    // Invalidar cache del subnegocio (donde mira el usuario) y del principal (donde vive el artículo)
    invalidateCacheForBiz(bizId);
    if (storageBizId !== bizId) invalidateCacheForBiz(storageBizId);

    return res.json({ ok: true, articulo: updated[0] });

  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[actualizarArticulo]', e.message);
    next(e);
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE /businesses/:id/articles/:articleId
// Solo permite borrar artículos creados manualmente (id < 0)
// ─────────────────────────────────────────────────────────────
exports.eliminarArticulo = async (req, res, next) => {
  const bizId = getBusinessId(req);
  const articleId = Number(req.params.articleId);

  if (!Number.isFinite(bizId) || !Number.isFinite(articleId)) {
    return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
  }
  if (articleId >= 0) {
    return res.status(400).json({ ok: false, error: 'Solo se pueden eliminar artículos creados manualmente' });
  }

  // 🆕 Si bizId es subnegocio, el artículo vive en el principal
  const storageBizId = await resolveStorageBizId(bizId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Borrar de app_articles
    const { rowCount } = await client.query(
      `DELETE FROM app_articles WHERE id = $1 AND business_id = $2`, [articleId, storageBizId]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Artículo no encontrado' });
    }

    // 🆕 Borrar también de maxi_articles (antes quedaba huérfano)
    await client.query(
      `DELETE FROM maxi_articles WHERE business_id = $1 AND articulo_id = $2`,
      [storageBizId, articleId]
    );

    await client.query('COMMIT');

    invalidateCacheForBiz(bizId);
    if (storageBizId !== bizId) invalidateCacheForBiz(storageBizId);

    return res.json({ ok: true, deleted: articleId });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[eliminarArticulo]', e.message);
    next(e);
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────
// GET /businesses/:id/articles/sin-equivalencia
// Lista artículos sin código externo asociado
// ─────────────────────────────────────────────────────────────
exports.listSinEquivalencia = async (req, res, next) => {
  const bizId = getBusinessId(req);
  if (!Number.isFinite(bizId)) return res.status(400).json({ ok: false, error: 'businessId inválido' });

  // 🆕 Si bizId es subnegocio, los artículos viven en el principal
  const storageBizId = await resolveStorageBizId(bizId);

  try {
    const { rows } = await pool.query(
      `SELECT id, name, rubro, subrubro, price, props, updated_at
         FROM app_articles
        WHERE business_id = $1
          AND (
            (props->>'sin_equivalencia')::boolean = true
            OR (props->>'origen' = 'manual' AND (props->>'codigo_externo') IS NULL)
          )
        ORDER BY name`,
      [storageBizId]
    );
    return res.json({ ok: true, articulos: rows });
  } catch (e) {
    next(e);
  }
};

// ─────────────────────────────────────────────────────────────
// GET /businesses/:id/config-costeo
// Devuelve la configuración de precio a usar para costear
// modo: 'ultima_compra' | 'promedio_30' | 'precio_db'
// ─────────────────────────────────────────────────────────────
exports.getConfigCosteo = async (req, res, next) => {
  try {
    const biz = req.business;
    const props = biz?.props || {};
    return res.json({
      ok: true,
      config: {
        precio_costeo_insumos: props.precio_costeo_insumos || 'ultima_compra',
      },
    });
  } catch (e) { next(e); }
};

// ─────────────────────────────────────────────────────────────
// PATCH /businesses/:id/config-costeo
// Guarda la configuración de precio de costeo
// Body: { modo: 'ultima_compra' | 'promedio_30' | 'precio_db' }
// ─────────────────────────────────────────────────────────────
exports.saveConfigCosteo = async (req, res, next) => {
  const bizId = getBusinessId(req);
  if (!Number.isFinite(bizId)) return res.status(400).json({ ok: false, error: 'businessId inválido' });

  const { modo } = req.body || {};
  const MODOS_VALIDOS = ['ultima_compra', 'promedio_30', 'precio_db'];
  if (!MODOS_VALIDOS.includes(modo)) {
    return res.status(400).json({ ok: false, error: `Modo inválido. Opciones: ${MODOS_VALIDOS.join(', ')}` });
  }

  try {
    await pool.query(
      `UPDATE app_businesses
          SET props = COALESCE(props, '{}'::jsonb) || jsonb_build_object('precio_costeo_insumos', $1),
              updated_at = NOW()
        WHERE id = $2`,
      [modo, bizId]
    );
    return res.json({ ok: true, modo });
  } catch (e) {
    console.error('[saveConfigCosteo]', e.message);
    next(e);
  }
};

// ─────────────────────────────────────────────────────────────
// GET /businesses/:id/articles-alertas-ventas
// Devuelve info de última venta por artículo y alerta si
// supera el límite de días configurado
// ─────────────────────────────────────────────────────────────
exports.alertasVentas = async (req, res, next) => {
  const bizId = getBusinessId(req);
  if (!Number.isFinite(bizId)) return res.status(400).json({ ok: false, error: 'businessId inválido' });

  try {
    const biz = req.business;
    const diasAlerta = Number(biz?.props?.ventas_alerta_dias || 30);

    const { rows } = await pool.query(
      `SELECT MAX(day) AS ultima_venta
         FROM sales_daily_items
        WHERE business_id = $1`,
      [bizId]
    );

    const ultimaVenta = rows[0]?.ultima_venta || null;
    const diasSinVentas = ultimaVenta
      ? Math.floor((Date.now() - new Date(ultimaVenta).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    return res.json({
      ok: true,
      ultimaVenta,
      diasSinVentas,
      diasAlerta,
      hayAlerta: diasSinVentas !== null && diasSinVentas > diasAlerta,
    });
  } catch (e) {
    next(e);
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// GET /businesses/:id/articles/batches
// Lista lotes de artículos Y rubros importados manualmente
// ─────────────────────────────────────────────────────────────────────────────
exports.listBatchesArticulos = async (req, res, next) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) return res.status(400).json({ ok: false, error: 'businessId requerido' });

    // Lotes de artículos (maxi_articles)
    const { rows: artRows } = await pool.query(
      `SELECT
         COALESCE(upload_batch_id, 'manual-sin-lote') AS batch_id,
         MIN(updated_at)                              AS created_at,
         COUNT(*)::int                                AS total_items,
         string_agg(DISTINCT COALESCE(origen,'manual'), ', ') AS origenes,
         'articulos' AS tipo
       FROM maxi_articles
       WHERE business_id = $1
         AND (upload_batch_id IS NOT NULL OR origen IN ('manual','csv'))
       GROUP BY COALESCE(upload_batch_id, 'manual-sin-lote')
       ORDER BY MIN(updated_at) DESC`,
      [bizId]
    );

    // Lotes de rubros (articulo_rubros) — si existe la tabla
    let rubRows = [];
    try {
      const { rows } = await pool.query(
        `SELECT
           COALESCE(upload_batch_id, 'rubros-sin-lote') AS batch_id,
           MIN(updated_at)                              AS created_at,
           COUNT(*)::int                                AS total_items,
           destino                                      AS origenes,
           'rubros' AS tipo
         FROM articulo_rubros
         WHERE business_id = $1
         GROUP BY COALESCE(upload_batch_id, 'rubros-sin-lote'), destino
         ORDER BY MIN(updated_at) DESC`,
        [bizId]
      );
      rubRows = rows;
    } catch { /* tabla puede no existir todavía */ }

    const data = [...artRows, ...rubRows].sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    );

    return res.json({ ok: true, data });
  } catch (e) { next(e); }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /businesses/:id/articles/batches/:batchId/preview
// ─────────────────────────────────────────────────────────────────────────────
exports.previewBatchArticulos = async (req, res, next) => {
  try {
    const bizId = getBusinessId(req);
    const batchId = req.params.batchId;
    if (!bizId || !batchId) return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });

    // Detectar si es lote de rubros por el prefijo
    const esRubros = batchId.startsWith('rubros-');
    const isSinLote = batchId === 'manual-sin-lote' || batchId === 'rubros-sin-lote';

    let rows = [];
    if (esRubros) {
      try {
        const q = isSinLote
          ? `SELECT id, codigo AS articulo_id, nombre, destino AS categoria, NULL AS subrubro, NULL AS precio, updated_at
               FROM articulo_rubros WHERE business_id = $1 AND upload_batch_id IS NULL
               ORDER BY nombre ASC LIMIT 200`
          : `SELECT id, codigo AS articulo_id, nombre, destino AS categoria, NULL AS subrubro, NULL AS precio, updated_at
               FROM articulo_rubros WHERE business_id = $1 AND upload_batch_id = $2
               ORDER BY nombre ASC LIMIT 200`;
        const res2 = await pool.query(q, isSinLote ? [bizId] : [bizId, batchId]);
        rows = res2.rows;
      } catch { rows = []; }
    } else {
      const q = isSinLote
        ? `SELECT articulo_id AS id, nombre, categoria, subrubro, precio, origen, updated_at
             FROM maxi_articles
            WHERE business_id = $1 AND upload_batch_id IS NULL AND origen IN ('manual','csv')
            ORDER BY nombre ASC LIMIT 200`
        : `SELECT articulo_id AS id, nombre, categoria, subrubro, precio, origen, updated_at
             FROM maxi_articles
            WHERE business_id = $1 AND upload_batch_id = $2
            ORDER BY nombre ASC LIMIT 200`;
      const res2 = await pool.query(q, isSinLote ? [bizId] : [bizId, batchId]);
      rows = res2.rows;
    }

    return res.json({ ok: true, data: rows, total: rows.length });
  } catch (e) { next(e); }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /businesses/:id/articles/batches/:batchId
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteBatchArticulos = async (req, res, next) => {
  try {
    const bizId = getBusinessId(req);
    const batchId = req.params.batchId;
    if (!bizId || !batchId) return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });

    const esRubros = batchId.startsWith('rubros-');
    const isSinLote = batchId === 'manual-sin-lote' || batchId === 'rubros-sin-lote';

    let rowCount = 0;
    if (esRubros) {
      try {
        const r = await pool.query(
          isSinLote
            ? `DELETE FROM articulo_rubros WHERE business_id = $1 AND upload_batch_id IS NULL`
            : `DELETE FROM articulo_rubros WHERE business_id = $1 AND upload_batch_id = $2`,
          isSinLote ? [bizId] : [bizId, batchId]
        );
        rowCount = r.rowCount;
      } catch { rowCount = 0; }
    } else {
      const r = await pool.query(
        isSinLote
          ? `DELETE FROM maxi_articles WHERE business_id = $1 AND upload_batch_id IS NULL AND origen IN ('csv','manual')`
          : `DELETE FROM maxi_articles WHERE business_id = $1 AND upload_batch_id = $2 AND origen IN ('csv','manual')`,
        isSinLote ? [bizId] : [bizId, batchId]
      );
      rowCount = r.rowCount;
    }

    return res.json({ ok: true, deleted: rowCount, batchId });
  } catch (e) { next(e); }
};

// GET /businesses/:id/articles/search-padrino?q=texto
// Busca artículos candidatos para usar como "padrino" (referencia de alta manual).
// Busca en el principal de la org, excluye discontinuados de cualquier biz de la org.
exports.searchPadrino = async (req, res) => {
  try {
    const bizId = Number(req.params.id || req.params.businessId);
    const q = String(req.query.q || '').trim();

    if (!Number.isFinite(bizId)) {
      return res.status(400).json({ ok: false, error: 'business_id inválido' });
    }
    if (q.length < 2) {
      return res.json({ ok: true, candidatos: [] });
    }

    // Los artículos viven en el principal (Opción B)
    // Los artículos viven en el principal (Opción B)
    const storageBizId = await resolveStorageBizId(bizId);

    // Leer flag invertir_jerarquia del principal (define la convención rubro↔subrubro de la org)
    const { rows: storageRows } = await pool.query(
      `SELECT props, organization_id FROM app_businesses WHERE id = $1`, [storageBizId]
    );
    const invertir = storageRows[0]?.props?.invertir_jerarquia_articulos === true;
    const orgId = storageRows[0]?.organization_id;

    let allBizIds = [storageBizId];
    if (orgId) {
      const { rows: orgBizs } = await pool.query(
        `SELECT id FROM app_businesses WHERE organization_id = $1`, [orgId]
      );
      allBizIds = orgBizs.map(r => Number(r.id));
    }

    const { rows: discRows } = await pool.query(
      `SELECT COALESCE(a.articulos, '[]'::jsonb) AS articulos
         FROM agrupaciones a
        WHERE a.business_id = ANY($1::int[])
          AND (a.nombre ILIKE 'Discontinuados' OR a.nombre ILIKE 'Descontinuados')`,
      [allBizIds]
    );

    const discontinuadosIds = new Set();
    for (const disc of discRows) {
      const arts = Array.isArray(disc.articulos) ? disc.articulos
        : (typeof disc.articulos === 'string' ? JSON.parse(disc.articulos || '[]') : []);
      for (const a of arts) {
        const id = Number(a?.id);
        if (Number.isFinite(id)) discontinuadosIds.add(id);
      }
    }

    // Búsqueda por nombre o SKU, prioriza prefijo
   // Búsqueda por nombre, prioriza prefijo
    const likeQuery = `%${q}%`;
    const prefixQuery = `${q}%`;
    // Respetar el flag invertir_jerarquia: si está activo,
    // "rubro" de la UI corresponde a ma.categoria, y "subrubro" a ma.subrubro
    const colRubro = invertir ? 'ma.categoria' : 'ma.subrubro';
    const colSubrubro = invertir ? 'ma.subrubro' : 'ma.categoria';

    const { rows: artRows } = await pool.query(
      `SELECT
         ma.articulo_id AS id,
         ma.nombre,
         ${colRubro} AS rubro,
         ${colSubrubro} AS subrubro,
         ma.precio
       FROM maxi_articles ma
      WHERE ma.business_id = $1
        AND ma.nombre ILIKE $2
        AND ma.is_active = true
      ORDER BY
        CASE WHEN ma.nombre ILIKE $3 THEN 0 ELSE 1 END,
        LENGTH(ma.nombre),
        ma.nombre
      LIMIT 30`,
      [storageBizId, likeQuery, prefixQuery]
    );

    const candidatos = artRows
      .filter(r => !discontinuadosIds.has(Number(r.id)))
      .slice(0, 15)
      .map(r => ({
        id: Number(r.id),
        nombre: r.nombre,
        rubro: r.rubro || null,
        subrubro: r.subrubro || null,
        precio: Number(r.precio) || 0,
      }));

    return res.json({ ok: true, candidatos });
  } catch (e) {
    console.error('searchPadrino error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};