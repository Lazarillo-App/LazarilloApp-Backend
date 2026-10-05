// controllers/articulosABMController.js
// Alta, baja y modificación manual de artículos desde Lazarillo
'use strict';

const pool = require('../config/db');
const { invalidateCacheForBiz } = require('../middleware/cacheJson');
const { logAudit } = require('../services/audit/auditLog');

// 'mayuscula' → TODO MAYÚSCULA. 'titulo' → solo la primera letra del nombre en
// mayúscula, el resto en minúscula (así lo pidió la usuaria explícitamente,
// no es "Title Case" palabra por palabra).
function normalizarNombreFn(formato) {
  return (s) => {
    const t = String(s || '').trim();
    if (!t) return t;
    if (formato === 'mayuscula') return t.toUpperCase();
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  };
}

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

    // Convención fija del sistema (misma que crearArticulo/actualizarArticulo/
    // ArticuloAccionesMenu/listArticlesTreeFromDB): "Rubro" UI = columna subrubro en
    // maxi_articles, "Subrubro" UI = columna categoria. El flag invertir_jerarquia_articulos
    // nunca se setea desde ninguna pantalla (no hay UI para eso), así que antes esta
    // función SIEMPRE corría con el mapeo al revés de esa convención — el desplegable
    // de Subrubro al editar un artículo no matcheaba ningún grupo real.
    const byCategoria = {};
    for (const row of rows) {
      const cat = row.col_rubro || 'Sin rubro';
      const sub = row.col_subrubro;
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

  const { nombre, rubro, subrubro, precio, agrupacionId, skuExterno } = req.body || {};

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
  // Convención del sistema (alineada con sidebar/árbol):
  // "rubro" UI corresponde a ma.subrubro DB
  // "subrubro" UI corresponde a ma.categoria DB
  const maxiCategoria = subrubro?.trim() || null;
  const maxiSubrubro = rubro.trim();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
    // Si vino skuExterno (código de Maxi), usarlo. Sino, generar provisorio L001, L002...
    const numStr = String(Math.abs(newId)).padStart(3, '0');
    const skuProvisorio = `L${numStr}`;
    const skuFinal = skuExterno?.trim() || skuProvisorio;
    const tieneSkuExterno = !!skuExterno?.trim();

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
        JSON.stringify({
          origen: 'manual',
          sku: skuFinal,
          codigo_externo: tieneSkuExterno ? skuExterno.trim() : null,
          sin_equivalencia: !tieneSkuExterno,
        }),
      ]
    );

    const articulo = artRows[0];

    // Guardar también el SKU en la columna codigo
    await client.query(
      `UPDATE app_articles SET codigo = $1 WHERE id = $2 AND business_id = $3`,
      [skuFinal, newId, storageBizId]
    );

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
    return res.status(201).json({ ok: true, articulo, sku: skuFinal });

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
// GET /:id/articles/:articleId — datos completos para el modal de edición
// (código, nombre_original) que el objeto de fila de la tabla no siempre trae.
exports.obtenerArticulo = async (req, res, next) => {
  const bizId = getBusinessId(req);
  const articleId = Number(req.params.articleId);
  if (!Number.isFinite(bizId) || !Number.isFinite(articleId)) {
    return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
  }
  try {
    const storageBizId = await resolveStorageBizId(bizId);
    if (articleId < 0) {
      const { rows } = await pool.query(
        `SELECT id, name AS nombre, rubro, subrubro, price AS precio, codigo,
                nombre_original
           FROM app_articles WHERE id = $1 AND business_id = $2`,
        [articleId, storageBizId]
      );
      if (!rows.length) return res.status(404).json({ ok: false, error: 'No encontrado' });
      return res.json({ ok: true, articulo: rows[0] });
    }
    // Recordatorio: en maxi_articles, subrubro DB = "Rubro" UI, categoria DB = "Subrubro" UI.
    const { rows } = await pool.query(
      `SELECT ma.articulo_id AS id, ma.nombre,
              ma.subrubro AS rubro, ma.categoria AS subrubro,
              ma.precio, aa.codigo, ma.nombre_original
         FROM maxi_articles ma
         LEFT JOIN app_articles aa ON aa.id = ma.articulo_id AND aa.business_id = ma.business_id
        WHERE ma.business_id = $1 AND ma.articulo_id = $2`,
      [storageBizId, articleId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'No encontrado' });
    return res.json({ ok: true, articulo: rows[0] });
  } catch (e) {
    console.error('[obtenerArticulo]', e.message);
    next(e);
  }
};

exports.actualizarArticulo = async (req, res, next) => {
  const bizId = getBusinessId(req);
  const articleId = Number(req.params.articleId);
  if (!Number.isFinite(bizId) || !Number.isFinite(articleId)) {
    return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
  }

  const { nombre, rubro, subrubro, precio, codigoExterno } = req.body || {};
  const storageBizId = await resolveStorageBizId(bizId);
  const isManual = articleId < 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ─── Rama A: artículo Maxi (id > 0) ────────────────────────────────────
    if (!isManual) {
      const { rows } = await client.query(
        `SELECT * FROM maxi_articles WHERE business_id = $1 AND articulo_id = $2`,
        [storageBizId, articleId]
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'Artículo no encontrado en maxi_articles' });
      }

      const art = rows[0];
      const sets = [];
      const vals = [];
      let pi = 1;

      if (nombre?.trim() && nombre.trim() !== art.nombre) {
        sets.push(`nombre = $${pi++}`); vals.push(nombre.trim());
        // Congelar el nombre de origen (POS/sync) la PRIMERA vez que se renombra desde
        // Lazarillo — después queda fijo aunque se vuelva a renombrar otra vez.
        if (!art.nombre_original) { sets.push(`nombre_original = $${pi++}`); vals.push(art.nombre); }
      }
      if (precio != null) { sets.push(`precio = $${pi++}`); vals.push(safeNum(precio) ?? 0); }
      // Recordatorio: en maxi_articles → subrubro DB = "Rubro" UI, categoria DB = "Subrubro" UI
      if (rubro?.trim() != null && rubro.trim() !== art.subrubro) {
        sets.push(`subrubro = $${pi++}`); vals.push(rubro.trim());
      }
      if (subrubro?.trim() != null && subrubro.trim() !== art.categoria) {
        sets.push(`categoria = $${pi++}`); vals.push(subrubro.trim());
      }

      if (!sets.length) {
        await client.query('ROLLBACK');
        return res.json({ ok: true, articulo: art, message: 'Sin cambios' });
      }

      sets.push(`updated_at = NOW()`);
      vals.push(storageBizId, articleId);

      const { rows: updated } = await client.query(
        `UPDATE maxi_articles SET ${sets.join(', ')}
          WHERE business_id = $${pi++} AND articulo_id = $${pi}
         RETURNING *`,
        vals
      );

      await client.query('COMMIT');
      invalidateCacheForBiz(bizId);
      if (storageBizId !== bizId) invalidateCacheForBiz(storageBizId);
      return res.json({ ok: true, articulo: updated[0] });
    }

    // ─── Rama B: artículo manual (id < 0) — lógica original ─────────────────
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

    if (nombre?.trim() && nombre.trim() !== art.name) {
      sets.push(`name = $${pi++}`); vals.push(nombre.trim());
      if (!art.nombre_original) { sets.push(`nombre_original = $${pi++}`); vals.push(art.name); }
    }
    if (precio != null) { sets.push(`price = $${pi++}`); vals.push(safeNum(precio) ?? 0); }

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
      subrubroId = 1;
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
    vals.push(articleId, storageBizId);
    const { rows: updated } = await client.query(
      `UPDATE app_articles SET ${sets.join(', ')}
        WHERE id = $${pi++} AND business_id = $${pi}
       RETURNING *`,
      vals
    );

    // ── Espejo en maxi_articles: los manuales/promos también viven ahí (para el árbol) ──
    const mSets = [];
    const mVals = [];
    let mi = 1;
    if (nombre?.trim()) { mSets.push(`nombre = $${mi++}`); mVals.push(nombre.trim()); }
    if (precio != null) { mSets.push(`precio = $${mi++}`); mVals.push(safeNum(precio) ?? 0); }
    // Recordatorio: en maxi_articles → subrubro DB = "Rubro" UI, categoria DB = "Subrubro" UI
    if (rubro?.trim()) { mSets.push(`subrubro = $${mi++}`); mVals.push(rubro.trim()); }
    if (subrubro?.trim()) { mSets.push(`categoria = $${mi++}`); mVals.push(subrubro.trim()); }
    if (mSets.length) {
      mSets.push(`updated_at = NOW()`);
      mVals.push(storageBizId, articleId);
      await client.query(
        `UPDATE maxi_articles SET ${mSets.join(', ')}
          WHERE business_id = $${mi++} AND articulo_id = $${mi}`,
        mVals
      );
    }

    await client.query('COMMIT');
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
// POST /businesses/:id/articles/normalizar-nombres
// Body: { formato: 'mayuscula' | 'titulo' }
// Pasa el nombre de TODOS los artículos del negocio (maxi + manuales) al
// formato elegido. Para los de MaxiRest, solo se toca maxi_articles.nombre
// (nunca nombre_maxi) — el mismo truco que ya usa el renombre manual desde
// ArticuloAccionesMenu para que la sync no lo pise después.
// ─────────────────────────────────────────────────────────────
exports.normalizarNombresArticulos = async (req, res, next) => {
  const bizId = getBusinessId(req);
  if (!Number.isFinite(bizId)) return res.status(400).json({ ok: false, error: 'businessId inválido' });
  const formato = req.body?.formato === 'mayuscula' ? 'mayuscula' : 'titulo';
  const transform = normalizarNombreFn(formato);
  const storageBizId = await resolveStorageBizId(bizId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: maxiRows } = await client.query(
      `SELECT articulo_id, nombre FROM maxi_articles WHERE business_id = $1`,
      [storageBizId]
    );
    let cambiados = 0;
    for (const r of maxiRows) {
      const nuevo = transform(r.nombre);
      if (nuevo && nuevo !== r.nombre) {
        await client.query(
          `UPDATE maxi_articles SET nombre = $1, updated_at = NOW() WHERE business_id = $2 AND articulo_id = $3`,
          [nuevo, storageBizId, r.articulo_id]
        );
        cambiados++;
      }
    }

    const { rows: manualRows } = await client.query(
      `SELECT id, name FROM app_articles WHERE business_id = $1`,
      [storageBizId]
    );
    for (const r of manualRows) {
      const nuevo = transform(r.name);
      if (nuevo && nuevo !== r.name) {
        await client.query(`UPDATE app_articles SET name = $1, updated_at = NOW() WHERE id = $2 AND business_id = $3`, [nuevo, r.id, storageBizId]);
        // Espejo en maxi_articles (los manuales también viven ahí, para el árbol).
        await client.query(`UPDATE maxi_articles SET nombre = $1, updated_at = NOW() WHERE business_id = $2 AND articulo_id = $3`, [nuevo, storageBizId, r.id]);
        cambiados++;
      }
    }

    // Rubro UI = maxi_articles.subrubro (convención invertida) + app_articles.rubro.
    // Mismo mecanismo que renombrarRubro: se actualiza por valor distinto, sin tocar
    // subrubro_maxi (así el próximo sync detecta la diferencia y no lo pisa).
    const { rows: rubroRows } = await client.query(
      `SELECT DISTINCT subrubro FROM maxi_articles
        WHERE business_id = $1 AND subrubro IS NOT NULL AND subrubro != ''`,
      [storageBizId]
    );
    for (const { subrubro } of rubroRows) {
      const nuevo = transform(subrubro);
      if (nuevo && nuevo !== subrubro) {
        await client.query(
          `UPDATE maxi_articles SET subrubro = $1, updated_at = NOW() WHERE business_id = $2 AND subrubro = $3`,
          [nuevo, storageBizId, subrubro]
        );
        await client.query(
          `UPDATE app_articles SET rubro = $1, updated_at = NOW() WHERE business_id = $2 AND rubro = $3`,
          [nuevo, storageBizId, subrubro]
        );
        cambiados++;
      }
    }

    // Subrubro UI = maxi_articles.categoria (convención invertida) + app_articles.subrubro.
    const { rows: subrubroRows } = await client.query(
      `SELECT DISTINCT categoria FROM maxi_articles
        WHERE business_id = $1 AND categoria IS NOT NULL AND categoria != ''`,
      [storageBizId]
    );
    for (const { categoria } of subrubroRows) {
      const nuevo = transform(categoria);
      if (nuevo && nuevo !== categoria) {
        await client.query(
          `UPDATE maxi_articles SET categoria = $1, updated_at = NOW() WHERE business_id = $2 AND categoria = $3`,
          [nuevo, storageBizId, categoria]
        );
        await client.query(
          `UPDATE app_articles SET subrubro = $1, updated_at = NOW() WHERE business_id = $2 AND subrubro = $3`,
          [nuevo, storageBizId, categoria]
        );
        cambiados++;
      }
    }

    await logAudit(client, {
      userId: req.user?.id || null, businessId: bizId,
      entityType: 'articulo', entityId: 0,
      action: 'update',
      diff: { after: { normalizarNombres: formato, cambiados } },
      metadata: { formato, cambiados, bulk: true },
    });

    await client.query('COMMIT');
    invalidateCacheForBiz(bizId);
    if (storageBizId !== bizId) invalidateCacheForBiz(storageBizId);

    return res.json({ ok: true, cambiados });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[normalizarNombresArticulos]', e.message);
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

    // 🆕 Quitar el ID de las agrupaciones (sino queda huérfano y reaparece al refetch).
    // articulos: jsonb array de objetos {id,...} → filtrar por elem->>'id'
    // app_articles_ids: jsonb array de números → filtrar el valor
    // jsonb_array_elements() revienta si la columna no es un array JSON (dato
    // viejo/inconsistente: NULL literal, "{}", etc.) — el CASE la trata como "[]"
    // en ese caso en vez de tirar abajo todo el borrado del artículo.
    await client.query(
      `UPDATE agrupaciones
          SET articulos = COALESCE((
                SELECT jsonb_agg(elem)
                  FROM jsonb_array_elements(
                         CASE WHEN jsonb_typeof(articulos) = 'array' THEN articulos ELSE '[]'::jsonb END
                       ) elem
                 WHERE (elem->>'id')::int IS DISTINCT FROM $2
              ), '[]'::jsonb),
              app_articles_ids = COALESCE((
                SELECT jsonb_agg(val)
                  FROM jsonb_array_elements(
                         CASE WHEN jsonb_typeof(app_articles_ids) = 'array' THEN app_articles_ids ELSE '[]'::jsonb END
                       ) val
                 WHERE (val)::text::int IS DISTINCT FROM $2
              ), '[]'::jsonb),
              updated_at = NOW()
        WHERE business_id = $1
          AND (
            articulos @> $3::jsonb
            OR app_articles_ids @> $4::jsonb
          )`,
      [storageBizId, articleId, JSON.stringify([{ id: articleId }]), JSON.stringify([articleId])]
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
    const storageBizId = await resolveStorageBizId(bizId);
    const isSubnegocio = storageBizId !== bizId;

    // Leer flag invertir_jerarquia del principal (define la convención rubro↔subrubro de la org)
    const { rows: storageRows } = await pool.query(
      `SELECT props, organization_id FROM app_businesses WHERE id = $1`, [storageBizId]
    );
    
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
    const colRubro = 'ma.subrubro';
    const colSubrubro = 'ma.categoria';

    // Buscar agrupaciones de TODA la org (incluye subnegocios)
    // y mapear cada articulo_id → primera agrupación real encontrada.
    const { rows: agRows } = await pool.query(
      `SELECT id, nombre, business_id, articulos, app_articles_ids
         FROM agrupaciones
        WHERE business_id = ANY($1::int[])
          AND nombre NOT ILIKE 'Sin Agrupac%'
          AND nombre NOT ILIKE 'Sin Agrupar%'
          AND nombre NOT ILIKE 'Discontinuados'
          AND nombre NOT ILIKE 'Descontinuados'`,
      [allBizIds]
    );

    const articleToAgrup = new Map(); // articleId → { id, nombre, business_id }
    for (const ag of agRows) {
      const arts = Array.isArray(ag.articulos) ? ag.articulos
        : (typeof ag.articulos === 'string' ? JSON.parse(ag.articulos || '[]') : []);
      const appIds = Array.isArray(ag.app_articles_ids) ? ag.app_articles_ids
        : (typeof ag.app_articles_ids === 'string' ? JSON.parse(ag.app_articles_ids || '[]') : []);
      const ids = new Set([
        ...arts.map(a => Number(a?.id ?? a?.articulo_id ?? a)).filter(n => Number.isFinite(n)),
        ...appIds.map(Number).filter(n => Number.isFinite(n)),
      ]);
      for (const id of ids) {
        if (!articleToAgrup.has(id)) {
          articleToAgrup.set(id, { id: Number(ag.id), nombre: ag.nombre, business_id: Number(ag.business_id) });
        }
      }
    }

    const { rows: artRows } = await pool.query(
      `SELECT
         ma.articulo_id AS id,
         ma.nombre,
         ${colRubro} AS rubro,
         ${colSubrubro} AS subrubro,
         ma.precio,
         aa.codigo AS sku
       FROM maxi_articles ma
       LEFT JOIN app_articles aa ON aa.id = ma.articulo_id AND aa.business_id = ma.business_id
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
      // Si estamos en un subnegocio, solo ofrecer como padrino artículos libres
      // (sin agrupación real todavía) o ya asignados a ESTE subnegocio — antes se
      // buscaba en todo el catálogo del principal sin importar a qué subnegocio
      // de la org pertenecía cada candidato.
      .filter(r => {
        if (!isSubnegocio) return true;
        const ag = articleToAgrup.get(Number(r.id));
        return !ag || Number(ag.business_id) === Number(bizId);
      })
      .slice(0, 15)
      .map(r => {
        const ag = articleToAgrup.get(Number(r.id)) || null;
        return {
          id: Number(r.id),
          nombre: r.nombre,
          rubro: r.rubro || null,
          subrubro: r.subrubro || null,
          precio: Number(r.precio) || 0,
          sku: r.sku || null,
          agrupacion_id: ag?.id ?? null,
          agrupacion_nombre: ag?.nombre ?? null,
          esMatch: true,
        };
      });

    // Además de los que matchean el texto, traer el resto de artículos de ESOS
    // MISMOS rubros — mismo criterio que searchPadrinoInsumo (insumosController.js):
    // ver de entrada todo lo que ya existe ahí, para no cargar un padrino duplicado.
    const rubrosEncontrados = [...new Set(candidatos.map(c => c.rubro).filter(Boolean))];
    let otrosEnRubro = [];
    if (rubrosEncontrados.length) {
      const idsYaListados = candidatos.map(c => c.id);
      const { rows: otrosRows } = await pool.query(
        `SELECT
           ma.articulo_id AS id,
           ma.nombre,
           ${colRubro} AS rubro,
           ${colSubrubro} AS subrubro,
           ma.precio,
           aa.codigo AS sku
         FROM maxi_articles ma
         LEFT JOIN app_articles aa ON aa.id = ma.articulo_id AND aa.business_id = ma.business_id
        WHERE ma.business_id = $1
          AND ma.is_active = true
          AND ma.articulo_id <> ALL($2::int[])
          AND ${colRubro} = ANY($3::text[])
        ORDER BY ma.nombre
        LIMIT 40`,
        [storageBizId, idsYaListados.length ? idsYaListados : [0], rubrosEncontrados]
      );
      otrosEnRubro = otrosRows
        .filter(r => !discontinuadosIds.has(Number(r.id)))
        .filter(r => {
          if (!isSubnegocio) return true;
          const ag = articleToAgrup.get(Number(r.id));
          return !ag || Number(ag.business_id) === Number(bizId);
        })
        .map(r => {
          const ag = articleToAgrup.get(Number(r.id)) || null;
          return {
            id: Number(r.id),
            nombre: r.nombre,
            rubro: r.rubro || null,
            subrubro: r.subrubro || null,
            precio: Number(r.precio) || 0,
            sku: r.sku || null,
            agrupacion_id: ag?.id ?? null,
            agrupacion_nombre: ag?.nombre ?? null,
            esMatch: false,
          };
        });
    }

    return res.json({ ok: true, candidatos: [...candidatos, ...otrosEnRubro] });
  } catch (e) {
    console.error('searchPadrino error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /businesses/:id/articles/rubros/rename
// Body: { old: string, new: string }
// Renombra el "rubro" UI (que en DB es maxi_articles.subrubro y app_articles.rubro).
// Afecta todas las filas del negocio que tenían el nombre viejo.
// ─────────────────────────────────────────────────────────────────────────────
exports.renombrarRubro = async (req, res, next) => {
  const bizId = getBusinessId(req);
  const oldName = String(req.body?.old ?? '').trim();
  const newName = String(req.body?.new ?? '').trim();

  if (!Number.isFinite(bizId) || !oldName || !newName) {
    return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
  }
  if (oldName === newName) {
    return res.json({ ok: true, message: 'Sin cambios' });
  }

  const storageBizId = await resolveStorageBizId(bizId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Rubro UI = maxi_articles.subrubro (convención invertida del proyecto)
    const r1 = await client.query(
      `UPDATE maxi_articles SET subrubro = $1, updated_at = NOW()
        WHERE business_id = $2 AND subrubro = $3`,
      [newName, storageBizId, oldName]
    );
    // En app_articles la columna se llama "rubro"
    const r2 = await client.query(
      `UPDATE app_articles SET rubro = $1, updated_at = NOW()
        WHERE business_id = $2 AND rubro = $3`,
      [newName, storageBizId, oldName]
    );

    await client.query('COMMIT');
    invalidateCacheForBiz(bizId);
    if (storageBizId !== bizId) invalidateCacheForBiz(storageBizId);

    return res.json({
      ok: true,
      maxi_updated: r1.rowCount,
      app_updated: r2.rowCount,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[renombrarRubro]', e.message);
    next(e);
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /businesses/:id/articles/subrubros/rename
// Body: { old: string, new: string, rubro?: string }
// Renombra el "subrubro" UI (maxi_articles.categoria y app_articles.subrubro).
// El parámetro opcional "rubro" limita el rename a un rubro padre específico
// (útil si el mismo subrubro existe bajo varios rubros).
// ─────────────────────────────────────────────────────────────────────────────
exports.renombrarSubrubro = async (req, res, next) => {
  const bizId = getBusinessId(req);
  const oldName = String(req.body?.old ?? '').trim();
  const newName = String(req.body?.new ?? '').trim();
  const rubroFilter = req.body?.rubro != null ? String(req.body.rubro).trim() : null;

  if (!Number.isFinite(bizId) || !oldName || !newName) {
    return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
  }
  if (oldName === newName) {
    return res.json({ ok: true, message: 'Sin cambios' });
  }

  const storageBizId = await resolveStorageBizId(bizId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Subrubro UI = maxi_articles.categoria (convención invertida).
    // Si vino "rubro", limitamos por maxi_articles.subrubro (el rubro UI).
    const maxiArgs = [newName, storageBizId, oldName];
    let maxiSql = `UPDATE maxi_articles SET categoria = $1, updated_at = NOW()
                    WHERE business_id = $2 AND categoria = $3`;
    if (rubroFilter) {
      maxiArgs.push(rubroFilter);
      maxiSql += ` AND subrubro = $4`;
    }
    const r1 = await client.query(maxiSql, maxiArgs);

    // En app_articles la columna se llama "subrubro" (y "rubro" para filtrar el padre).
    const appArgs = [newName, storageBizId, oldName];
    let appSql = `UPDATE app_articles SET subrubro = $1, updated_at = NOW()
                   WHERE business_id = $2 AND subrubro = $3`;
    if (rubroFilter) {
      appArgs.push(rubroFilter);
      appSql += ` AND rubro = $4`;
    }
    const r2 = await client.query(appSql, appArgs);

    await client.query('COMMIT');
    invalidateCacheForBiz(bizId);
    if (storageBizId !== bizId) invalidateCacheForBiz(storageBizId);

    return res.json({
      ok: true,
      maxi_updated: r1.rowCount,
      app_updated: r2.rowCount,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[renombrarSubrubro]', e.message);
    next(e);
  } finally {
    client.release();
  }
};