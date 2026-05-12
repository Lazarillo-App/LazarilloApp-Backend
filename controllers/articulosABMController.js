// controllers/articulosABMController.js
// Alta, baja y modificación manual de artículos desde Lazarillo
'use strict';

const pool = require('../config/db');

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

// ─────────────────────────────────────────────────────────────
// GET /businesses/:id/rubros
// Devuelve categorias + subrubros del negocio (de app_articles)
// ─────────────────────────────────────────────────────────────
exports.getRubros = async (req, res, next) => {
  try {
    const bizId = getBusinessId(req);
    if (!Number.isFinite(bizId)) return res.status(400).json({ ok: false, error: 'businessId inválido' });

    // Categorías y subrubros usados en este negocio
    const { rows } = await pool.query(
      `SELECT DISTINCT
         a.rubro    AS categoria,
         a.subrubro AS subrubro
       FROM app_articles a
       WHERE a.business_id = $1
         AND a.rubro IS NOT NULL
         AND a.rubro != ''
         AND a.rubro NOT ILIKE '%pendiente%'
       ORDER BY a.rubro, a.subrubro`,
      [bizId]
    );

    // Agrupar por categoría
    const byCategoria = {};
    for (const row of rows) {
      const cat = row.categoria || 'Sin rubro';
      if (!byCategoria[cat]) byCategoria[cat] = [];
      if (row.subrubro && !row.subrubro.includes('[PENDIENTE]')) {
        byCategoria[cat].push(row.subrubro);
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
  if (!rubro?.trim())  return res.status(400).json({ ok: false, error: 'Rubro requerido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ID negativo secuencial para artículos manuales (no interfiere con IDs de Maxi)
    const { rows: minRows } = await client.query(
      `SELECT COALESCE(MIN(id), 0) - 1 AS next_id
         FROM app_articles
        WHERE business_id = $1 AND id < 0`,
      [bizId]
    );
    const newId = Math.min(minRows[0].next_id, -1);

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
    const skuProvisorio = `L-${bizId}-${Math.abs(newId)}`;

    // Insertar el artículo
    const { rows: artRows } = await client.query(
      `INSERT INTO app_articles
         (id, business_id, name, rubro, subrubro, node_type, price, categoria_id, subrubro_id, props, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'item', $6, $7, $8, $9, NOW())
       RETURNING *`,
      [
        newId,
        bizId,
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM app_articles WHERE id = $1 AND business_id = $2`, [articleId, bizId]
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
    let subrubroId  = art.subrubro_id;

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
    vals.push(articleId, bizId);

    const { rows: updated } = await client.query(
      `UPDATE app_articles SET ${sets.join(', ')}
        WHERE id = $${pi++} AND business_id = $${pi}
       RETURNING *`,
      vals
    );

    await client.query('COMMIT');
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

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM app_articles WHERE id = $1 AND business_id = $2`, [articleId, bizId]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: 'Artículo no encontrado' });
    return res.json({ ok: true, deleted: articleId });
  } catch (e) {
    console.error('[eliminarArticulo]', e.message);
    next(e);
  }
};

// ─────────────────────────────────────────────────────────────
// GET /businesses/:id/articles/sin-equivalencia
// Lista artículos sin código externo asociado
// ─────────────────────────────────────────────────────────────
exports.listSinEquivalencia = async (req, res, next) => {
  const bizId = getBusinessId(req);
  if (!Number.isFinite(bizId)) return res.status(400).json({ ok: false, error: 'businessId inválido' });

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
      [bizId]
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