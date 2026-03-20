// controllers/articlePriceConfigController.js
'use strict';

const pool = require('../config/db');

/* ══════════════════════════════════════════════════════════════
   GET /api/businesses/:businessId/recetas-costos
   Devuelve { article_id, costo_total, porciones } de todas las
   recetas activas del negocio. El front lo usa para poblar la
   columna Costo($) en TablaArticulos sin fetchear una por una.
══════════════════════════════════════════════════════════════ */
exports.getRecetasCostos = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    // Obtener config de alerta de semanas del negocio
    const { rows: bizRows } = await pool.query(
      `SELECT props FROM app_businesses WHERE id = $1`, [bizId]
    );
    const alertaSemanas = Number(bizRows[0]?.props?.compras_alerta_semanas ?? 4);
    const alertaMs = alertaSemanas * 7 * 24 * 60 * 60 * 1000;

    // Recetas con sus items e insumos — un solo query
    const { rows } = await pool.query(
      `SELECT
         r.article_id,
         r.costo_total,
         r.porciones,
         ri.insumo_id,
         -- Fecha última compra del insumo (en el negocio principal = credsBizId)
         (
           SELECT MAX(pi.fecha)
           FROM purchase_items pi
           WHERE pi.insumo_id = ri.insumo_id
             AND pi.precio > 0
         ) AS fecha_ultima_compra
       FROM recetas r
       JOIN receta_items ri ON ri.receta_id = r.id
       WHERE r.business_id = $1
         AND r.active = TRUE
         AND ri.tipo_costo != 'nulo'`,
      [bizId]
    );

    // Agrupar por article_id
    const costos = {};
    const ahora = Date.now();

    for (const r of rows) {
      const artId = Number(r.article_id);
      if (!costos[artId]) {
        costos[artId] = {
          costoTotal:   Number(r.costo_total) || 0,
          porciones:    Number(r.porciones)   || 1,
          tieneAlerta:  false,
          insumosAlerta: [],
        };
      }

      // Verificar alerta: sin compras o compra muy vieja
      const fechaUltima = r.fecha_ultima_compra ? new Date(r.fecha_ultima_compra).getTime() : null;
      const esVieja = !fechaUltima || (ahora - fechaUltima) > alertaMs;

      if (esVieja && r.insumo_id) {
        costos[artId].tieneAlerta = true;
        costos[artId].insumosAlerta.push(Number(r.insumo_id));
      }
    }

    return res.json({ ok: true, costos });
  } catch (e) {
    console.error('[getRecetasCostos]', e);
    next(e);
  }
};

/* ══════════════════════════════════════════════════════════════
   GET /api/businesses/:businessId/article-price-config
   Devuelve toda la config de precios del negocio:
     - byArticle:    { [articleId]:    { objetivo, precioManual } }
     - byRubro:      { [rubroKey]:     { objetivo } }
     - byAgrupacion: { [agrupacionId]: { objetivo } }
   El front resuelve la jerarquía: artículo > rubro > agrupación > global
══════════════════════════════════════════════════════════════ */
exports.getPriceConfig = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const { rows } = await pool.query(
      `SELECT scope, scope_id, objetivo_pct, precio_manual
         FROM article_price_config
        WHERE business_id = $1`,
      [bizId]
    );

    const byArticle    = {};
    const byRubro      = {};
    const byAgrupacion = {};

    for (const r of rows) {
      const entry = {
        objetivo:     r.objetivo_pct    != null ? Number(r.objetivo_pct)    : null,
        precioManual: r.precio_manual   != null ? Number(r.precio_manual)   : null,
      };
      if (r.scope === 'articulo') {
        byArticle[String(r.scope_id)] = entry;
      } else if (r.scope === 'rubro') {
        byRubro[String(r.scope_id)] = entry;
      } else if (r.scope === 'agrupacion') {
        byAgrupacion[String(r.scope_id)] = entry;
      }
    }

    return res.json({ ok: true, byArticle, byRubro, byAgrupacion });
  } catch (e) {
    console.error('[getPriceConfig]', e);
    next(e);
  }
};

/* ══════════════════════════════════════════════════════════════
   POST /api/businesses/:businessId/article-price-config
   Guarda o actualiza un valor de config.

   Body: {
     scope:        'articulo' | 'rubro' | 'agrupacion',
     scopeId:      string | number,   // articleId, rubroKey o agrupacionId
     objetivo?:    number | null,     // % objetivo (null = borrar override)
     precioManual?: number | null,    // precio manual en $ (null = borrar)
   }

   Cuando scope='agrupacion' y se pasa objetivo:
     → aplica ese objetivo a TODOS los artículos de la agrupación
       sobreescribiendo sus registros individuales de scope='articulo'
══════════════════════════════════════════════════════════════ */
exports.savePriceConfig = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const bizId = Number(req.params.businessId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const { scope, scopeId, objetivo, precioManual, articleIds } = req.body || {};

    const VALID_SCOPES = ['articulo', 'rubro', 'agrupacion'];
    if (!VALID_SCOPES.includes(scope)) {
      return res.status(400).json({ ok: false, error: 'scope_invalido' });
    }
    if (scopeId == null || String(scopeId).trim() === '') {
      return res.status(400).json({ ok: false, error: 'scopeId_requerido' });
    }

    const objetivoVal    = objetivo     != null ? Number(objetivo)     : null;
    const precioManualVal = precioManual != null ? Number(precioManual) : null;
    const scopeIdStr = String(scopeId).trim();

    await client.query('BEGIN');

    // ── Upsert del registro principal ──
    if (objetivoVal !== null || precioManualVal !== null) {
      await client.query(
        `INSERT INTO article_price_config
           (business_id, scope, scope_id, objetivo_pct, precio_manual, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (business_id, scope, scope_id)
         DO UPDATE SET
           objetivo_pct  = COALESCE(EXCLUDED.objetivo_pct,  article_price_config.objetivo_pct),
           precio_manual = COALESCE(EXCLUDED.precio_manual, article_price_config.precio_manual),
           updated_at    = NOW()`,
        [bizId, scope, scopeIdStr, objetivoVal, precioManualVal]
      );
    } else {
      // Si ambos son null → borrar el registro (resetear al nivel superior)
      await client.query(
        `DELETE FROM article_price_config
          WHERE business_id = $1 AND scope = $2 AND scope_id = $3`,
        [bizId, scope, scopeIdStr]
      );
    }

    // ── Si es agrupación con objetivo → override masivo en todos sus artículos ──
    if (scope === 'agrupacion' && objetivoVal !== null && Array.isArray(articleIds) && articleIds.length > 0) {
      for (const artId of articleIds) {
        const id = Number(artId);
        if (!Number.isFinite(id) || id <= 0) continue;
        await client.query(
          `INSERT INTO article_price_config
             (business_id, scope, scope_id, objetivo_pct, updated_at)
           VALUES ($1, 'articulo', $2, $3, NOW())
           ON CONFLICT (business_id, scope, scope_id)
           DO UPDATE SET
             objetivo_pct = EXCLUDED.objetivo_pct,
             updated_at   = NOW()`,
          [bizId, String(id), objetivoVal]
        );
      }
      console.log(`[savePriceConfig] Override masivo agrupación ${scopeIdStr} → ${articleIds.length} artículos con objetivo ${objetivoVal}%`);
    }

    await client.query('COMMIT');

    return res.json({ ok: true, scope, scopeId: scopeIdStr, objetivo: objetivoVal, precioManual: precioManualVal });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[savePriceConfig]', e);
    next(e);
  } finally {
    client.release();
  }
};

/* ══════════════════════════════════════════════════════════════
   DELETE /api/businesses/:businessId/article-price-config
   Borra el override de un scope/scopeId (vuelve al nivel superior)

   Body: { scope, scopeId }
══════════════════════════════════════════════════════════════ */
exports.deletePriceConfig = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const { scope, scopeId } = req.body || {};

    if (!bizId || !scope || scopeId == null) {
      return res.status(400).json({ ok: false, error: 'params_invalidos' });
    }

    await pool.query(
      `DELETE FROM article_price_config
        WHERE business_id = $1 AND scope = $2 AND scope_id = $3`,
      [bizId, scope, String(scopeId)]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('[deletePriceConfig]', e);
    next(e);
  }
};

/* ══════════════════════════════════════════════════════════════
   GET /api/businesses/:businessId/recetas-alertas
   Devuelve lista de insumos con compras vencidas que están
   siendo usados en recetas activas del negocio.
   Útil para el panel de alertas en Configuración → Artículos.
══════════════════════════════════════════════════════════════ */
exports.getRecetasAlertas = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const { rows: bizRows } = await pool.query(
      `SELECT props FROM app_businesses WHERE id = $1`, [bizId]
    );
    const alertaSemanas = Number(bizRows[0]?.props?.compras_alerta_semanas ?? 4);

    const { rows } = await pool.query(
      `SELECT
         i.id          AS insumo_id,
         i.nombre      AS insumo_nombre,
         i.unidad_med,
         MAX(pi.fecha) AS fecha_ultima_compra,
         COUNT(DISTINCT r.article_id)::int AS en_recetas,
         -- artículos afectados
         array_agg(DISTINCT r.article_id) AS article_ids
       FROM receta_items ri
       JOIN recetas r   ON r.id = ri.receta_id AND r.business_id = $1 AND r.active = TRUE
       JOIN insumos i   ON i.id = ri.insumo_id
       LEFT JOIN purchase_items pi ON pi.insumo_id = i.id AND pi.precio > 0
       WHERE ri.tipo_costo != 'nulo'
       GROUP BY i.id, i.nombre, i.unidad_med
       HAVING
         -- Sin compras o última compra hace más de N semanas
         MAX(pi.fecha) IS NULL
         OR MAX(pi.fecha) < CURRENT_DATE - ($2 || ' weeks')::interval
       ORDER BY fecha_ultima_compra ASC NULLS FIRST, i.nombre ASC`,
      [bizId, alertaSemanas]
    );

    return res.json({
      ok: true,
      alertaSemanas,
      total: rows.length,
      insumos: rows.map(r => ({
        insumoId:          Number(r.insumo_id),
        nombre:            r.insumo_nombre,
        unidadMed:         r.unidad_med,
        fechaUltimaCompra: r.fecha_ultima_compra
          ? String(r.fecha_ultima_compra).slice(0, 10)
          : null,
        enRecetas:         r.en_recetas,
        articleIds:        (r.article_ids || []).map(Number),
      })),
    });
  } catch (e) {
    console.error('[getRecetasAlertas]', e);
    next(e);
  }
};