// controllers/articlePriceConfigController.js
'use strict';

const pool = require('../config/db');
const { propagatePrecioManual, propagateObjetivo } = require('../services/linkPropagation');
const { logAudit } = require('../services/audit/auditLog');

/* ══════════════════════════════════════════════════════════════
   GET /api/businesses/:businessId/recetas-costos
══════════════════════════════════════════════════════════════ */
exports.getRecetasCostos = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const { rows: bizRows } = await pool.query(
      `SELECT props FROM app_businesses WHERE id = $1`, [bizId]
    );
    const alertaSemanas = Number(bizRows[0]?.props?.compras_alerta_semanas ?? 4);
    const alertaMs = alertaSemanas * 7 * 24 * 60 * 60 * 1000;

    const { rows } = await pool.query(
      `SELECT
         r.article_id,
         r.costo_total,
         r.porciones,
         ri.insumo_id,
         COALESCE(i.es_elaborado, FALSE) AS es_elaborado,
         COALESCE(i.tiene_receta, FALSE) AS tiene_receta,
         (
           SELECT MAX(pi.fecha)
           FROM purchase_items pi
           WHERE pi.insumo_id = ri.insumo_id
             AND pi.precio > 0
         ) AS fecha_ultima_compra
       FROM recetas r
       JOIN receta_items ri ON ri.receta_id = r.id
       LEFT JOIN insumos i ON i.id = ri.insumo_id AND i.business_id = $1
       WHERE r.business_id = $1
         AND r.active = TRUE
         AND ri.tipo_costo != 'nulo'`,
      [bizId]
    );

    const costos = {};
    const ahora = Date.now();

    for (const r of rows) {
      const artId = Number(r.article_id);
      if (!costos[artId]) {
        costos[artId] = {
          costoTotal: Number(r.costo_total) || 0,
          porciones: Number(r.porciones) || 1,
          tieneAlerta: false,
          insumosAlerta: [],
        };
      }

      // Los insumos elaborados no se compran (tienen receta), no marcan alerta
      const esElaborado = r.es_elaborado === true || r.tiene_receta === true;
      if (esElaborado) continue;

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
   Devuelve byArticle, byRubro, byAgrupacion
══════════════════════════════════════════════════════════════ */
exports.getPriceConfig = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const { rows } = await pool.query(
      `SELECT scope, scope_id, list_id, objetivo_pct, ajuste_pct, precio_manual, ultimo_pct, excluido
         FROM article_price_config
        WHERE business_id = $1
          AND list_id IS NULL`,
      [bizId]
    );

    const byArticle = {};
    const byRubro = {};
    const byAgrupacion = {};

    for (const r of rows) {
      const entry = {
        objetivo: r.objetivo_pct != null ? Number(r.objetivo_pct) : null,
        ajuste: r.ajuste_pct != null ? Number(r.ajuste_pct) : null,
        precioManual: r.precio_manual != null ? Number(r.precio_manual) : null,
        ultimoPct: r.ultimo_pct != null ? Number(r.ultimo_pct) : null,
        excluido: !!r.excluido,
      };
      if (r.scope === 'articulo') byArticle[String(r.scope_id)] = entry;
      else if (r.scope === 'rubro') byRubro[String(r.scope_id)] = entry;
      else if (r.scope === 'agrupacion') byAgrupacion[String(r.scope_id)] = entry;
    }

    return res.json({ ok: true, byArticle, byRubro, byAgrupacion });
  } catch (e) {
    console.error('[getPriceConfig]', e);
    next(e);
  }
};

/* ══════════════════════════════════════════════════════════════
   POST /api/businesses/:businessId/article-price-config

   Body común:
     scope, scopeId, objetivo?, precioManual?, articleIds?

   Flags especiales del frontend:
     pisarTodo   = true  → ignorar overrides individuales existentes,
                           aplicar el objetivo a todos los articleIds
     excluirIds  = [...] → lista de articleIds a NO tocar cuando
                           el usuario eligió "Solo los sin individual"
     scope       = 'global' → limpiar TODOS los overrides de objetivo
                              en byArticle + byRubro + byAgrupacion
                              (se usa desde ConfiguracionMain al pisar todo)
══════════════════════════════════════════════════════════════ */
exports.savePriceConfig = async (req, res, next) => {
  console.log('[savePriceConfig] VERSION 2026-06-23 con jerarquía agrupacion→rubro');  // ← temporal
  const client = await pool.connect();
  try {
    const bizId = Number(req.params.businessId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    const uid = req.user?.id || null;

    const {
      scope,
      scopeId,
      objetivo,
      precioManual,
      articleIds,
      pisarTodo = false,
      excluirIds = [],
      nuevoGlobal,
      ultimoPct,
    } = req.body || {};

    // ── Caso especial: scope='global' con pisarTodo=true ─────────────────────
    // Viene de ConfiguracionMain cuando el usuario elige "Pisar todo".
    // Elimina TODOS los overrides de objetivo (byArticle, byRubro, byAgrupacion)
    // para que el global sea el único valor vigente.
    // Los precioManual individuales NO se tocan (son precios $, no % objetivo).
    if (scope === 'global') {
      await client.query('BEGIN');

      if (pisarTodo) {
        // Eliminar objetivo_pct de TODOS los registros del negocio
        // pero conservar los que solo tienen precio_manual (no borrar ese campo)
        await client.query(
          `UPDATE article_price_config
             SET objetivo_pct = NULL, updated_at = NOW()
           WHERE business_id = $1`,
          [bizId]
        );
        // Borrar filas que quedaron con ambos campos null (ya no tienen utilidad)
        await client.query(
          `DELETE FROM article_price_config
           WHERE business_id = $1
             AND objetivo_pct IS NULL
             AND precio_manual IS NULL
             AND ultimo_pct IS NULL`,
          [bizId]
        );

        console.log(`[savePriceConfig] scope=global pisarTodo → limpiados todos los objetivos del negocio ${bizId}`);

        await logAudit(client, {
          userId: uid, businessId: bizId,
          entityType: 'precio_config', entityId: 'global',
          action: 'update',
          diff: { after: { scope: 'global', pisarTodo: true } },
          metadata: { scope: 'global', pisarTodo: true },
        });
      }
      // Si pisarTodo=false para scope='global', no hacemos nada extra:
      // el global (articulos_costo_ideal en props) ya se guarda aparte
      // vía BusinessesAPI.update — los overrides individuales se respetan solos
      // porque el front resuelve la jerarquía correctamente.

      await client.query('COMMIT');
      return res.json({ ok: true, scope: 'global', pisarTodo });
    }

    // ── Validaciones para scopes normales ─────────────────────────────────────
    const VALID_SCOPES = ['articulo', 'rubro', 'agrupacion'];
    if (!VALID_SCOPES.includes(scope)) {
      return res.status(400).json({ ok: false, error: 'scope_invalido' });
    }
    if (scopeId == null || String(scopeId).trim() === '') {
      return res.status(400).json({ ok: false, error: 'scopeId_requerido' });
    }

    const objetivoVal = objetivo != null ? Number(objetivo) : null;
    const precioManualVal = precioManual != null ? Number(precioManual) : null;
    const scopeIdStr = String(scopeId).trim();
    const ultimoPctVal = ultimoPct != null ? Number(ultimoPct) : null;

    await client.query('BEGIN');

    // ── Campos nuevos del modelo de listas ────────────────────────────────────
    const ajusteVal = req.body?.ajuste != null ? Number(req.body.ajuste) : null;
    const listIdVal = req.body?.listId != null ? Number(req.body.listId) : null;
    const excluidoVal = req.body?.excluido === true ? true
      : req.body?.excluido === false ? false
        : null;
    const listIdKey = listIdVal != null ? Number(listIdVal) : 0; // 0 = NULL para el UNIQUE

    // Declarados afuera del if/else de abajo: se necesitan más adelante para decidir
    // si hay que propagar el borrado de precio a los artículos vinculados.
    let borrarManual = false;
    let borrarObjetivo = false;
    let auditAction = 'update';

    // ── Upsert del registro principal (scope + scopeId + list_id) ────────────
    if (objetivoVal !== null || precioManualVal !== null || ultimoPctVal !== null
      || ajusteVal !== null || excluidoVal !== null) {
      await client.query(
        `INSERT INTO article_price_config
       (business_id, scope, scope_id, list_id, objetivo_pct, ajuste_pct, precio_manual, ultimo_pct, excluido, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::boolean, FALSE), NOW())
     ON CONFLICT (business_id, scope, scope_id, COALESCE(list_id, 0))
     DO UPDATE SET
       objetivo_pct  = CASE WHEN $5::numeric IS NOT NULL
                       THEN EXCLUDED.objetivo_pct
                       ELSE article_price_config.objetivo_pct END,
       ajuste_pct    = CASE WHEN $6::numeric IS NOT NULL
                       THEN EXCLUDED.ajuste_pct
                       ELSE article_price_config.ajuste_pct END,
       precio_manual = CASE WHEN $7::numeric IS NOT NULL
                       THEN EXCLUDED.precio_manual
                       ELSE article_price_config.precio_manual END,
       ultimo_pct    = CASE WHEN $8::numeric IS NOT NULL
                       THEN EXCLUDED.ultimo_pct
                       ELSE article_price_config.ultimo_pct END,
       excluido      = CASE WHEN $9::boolean IS NOT NULL
                       THEN EXCLUDED.excluido
                       ELSE article_price_config.excluido END,
       updated_at    = NOW()`,
        [bizId, scope, scopeIdStr, listIdVal, objetivoVal, ajusteVal, precioManualVal, ultimoPctVal, excluidoVal]
      );
    } else {
      // Borrar selectivamente según qué keys vinieron en el body.
      // `_deleteManual`: el botón "✕" de la tabla (TablaArticulos.jsx) manda este
      // flag en vez de `precioManual: null` — sin reconocerlo acá, el borrado no
      // hacía NADA en el backend (ni bodyKeys.includes('precioManual') ni la
      // propagación a vinculados de más abajo se disparaban).
      const bodyKeys = Object.keys(req.body || {});
      borrarManual = bodyKeys.includes('precioManual') || req.body?._deleteManual === true;
      borrarObjetivo = bodyKeys.includes('objetivo');

      if (borrarManual && borrarObjetivo) {
        auditAction = 'delete';
        await client.query(
          `DELETE FROM article_price_config
           WHERE business_id = $1 AND scope = $2 AND scope_id = $3`,
          [bizId, scope, scopeIdStr]
        );
      } else if (borrarManual) {
        await client.query(
          `UPDATE article_price_config
             SET precio_manual = NULL, updated_at = NOW()
           WHERE business_id = $1 AND scope = $2 AND scope_id = $3`,
          [bizId, scope, scopeIdStr]
        );
      } else if (borrarObjetivo) {
        await client.query(
          `UPDATE article_price_config
       SET objetivo_pct = NULL, updated_at = NOW()
     WHERE business_id = $1 AND scope = $2 AND scope_id = $3`,
          [bizId, scope, scopeIdStr]
        );

        // ✅ NUEVO: limpiar también objetivo_pct de artículos individuales
        if (Array.isArray(articleIds) && articleIds.length > 0) {
          const idsNums = articleIds.map(Number).filter(id => Number.isFinite(id) && id > 0);
          if (idsNums.length > 0) {
            await client.query(
              `UPDATE article_price_config
           SET objetivo_pct = NULL, updated_at = NOW()
         WHERE business_id = $1
           AND scope = 'articulo'
           AND scope_id = ANY($2::text[])`,
              [bizId, idsNums.map(String)]
            );
            await client.query(
              `DELETE FROM article_price_config
         WHERE business_id = $1
           AND scope = 'articulo'
           AND scope_id = ANY($2::text[])
           AND objetivo_pct IS NULL
           AND precio_manual IS NULL`,
              [bizId, idsNums.map(String)]
            );
          }
        }
      }
    }
    // ── Jerarquía "el padre pisa al hijo" ─────────────────────────────────────
    // Cuando se guarda un objetivo a nivel rubro o agrupación, borramos los
    // overrides individuales (scope='articulo') del bloque. No se materializa
    // nada: los artículos van a heredar el nuevo objetivo por jerarquía de lectura.
    // Los precios manuales NO se tocan — son independientes del objetivo.
    if (objetivoVal !== null && (scope === 'rubro' || scope === 'agrupacion')
      && Array.isArray(articleIds) && articleIds.length > 0) {
      const idsNums = articleIds.map(Number).filter(id => Number.isFinite(id) && id !== 0);
      if (idsNums.length > 0) {
        await client.query(
          `UPDATE article_price_config
             SET objetivo_pct = NULL, updated_at = NOW()
           WHERE business_id = $1
             AND scope = 'articulo'
             AND scope_id = ANY($2::text[])
             AND list_id IS NULL`,
          [bizId, idsNums.map(String)]
        );
        // Limpiar filas que quedaron sin ningún dato útil
        await client.query(
          `DELETE FROM article_price_config
           WHERE business_id = $1
             AND scope = 'articulo'
             AND scope_id = ANY($2::text[])
             AND list_id IS NULL
             AND objetivo_pct IS NULL
             AND precio_manual IS NULL
             AND ajuste_pct IS NULL
             AND ultimo_pct IS NULL
             AND excluido = FALSE`,
          [bizId, idsNums.map(String)]
        );
        console.log(`[savePriceConfig] ${scope}/${scopeIdStr} → limpiados overrides individuales de ${idsNums.length} artículos`);
        console.log(`[DEBUG] scope === 'agrupacion'?`, scope === 'agrupacion');

        // Si es agrupación, además limpiar todos los rubros que contienen estos artículos.
        if (scope === 'agrupacion') {
          const { rows: rubrosDelBloque } = await client.query(
            `SELECT DISTINCT subrubro, categoria FROM maxi_articles
               WHERE business_id = $1 AND articulo_id = ANY($2::int[])
             UNION
             SELECT DISTINCT subrubro, rubro AS categoria FROM app_articles
               WHERE business_id = $1 AND id = ANY($2::int[])`,
            [bizId, idsNums]
          );
          const rubroKeys = new Set();
          for (const r of rubrosDelBloque) {
            if (r.subrubro) rubroKeys.add(String(r.subrubro));
            if (r.categoria) rubroKeys.add(String(r.categoria));
          }
          if (rubroKeys.size > 0) {
            await client.query(
              `UPDATE article_price_config
                 SET objetivo_pct = NULL, updated_at = NOW()
               WHERE business_id = $1
                 AND scope = 'rubro'
                 AND scope_id = ANY($2::text[])
                 AND list_id IS NULL`,
              [bizId, Array.from(rubroKeys)]
            );
            await client.query(
              `DELETE FROM article_price_config
               WHERE business_id = $1
                 AND scope = 'rubro'
                 AND scope_id = ANY($2::text[])
                 AND list_id IS NULL
                 AND objetivo_pct IS NULL
                 AND precio_manual IS NULL
                 AND ajuste_pct IS NULL
                 AND ultimo_pct IS NULL
                 AND excluido = FALSE`,
              [bizId, Array.from(rubroKeys)]
            );
            console.log(`[savePriceConfig] agrupacion/${scopeIdStr} → limpiados ${rubroKeys.size} rubros del bloque`);
          }
        }
      }
    }

    await logAudit(client, {
      userId: uid, businessId: bizId,
      entityType: 'precio_config', entityId: scopeIdStr,
      action: auditAction,
      diff: {
        after: {
          objetivo: objetivoVal,
          precioManual: precioManualVal,
          ajuste: ajusteVal,
          ultimoPct: ultimoPctVal,
          excluido: excluidoVal,
        },
      },
      metadata: {
        scope,
        listId: listIdVal,
        borrarManual,
        borrarObjetivo,
        articulosAfectados: Array.isArray(articleIds) ? articleIds.length : 0,
      },
    });

    await client.query('COMMIT');

    // ── Propagación a artículos vinculados ─────────────────────────────────
    // Solo propagamos cuando es scope='articulo' (cambio individual).
    // Los cambios de rubro/agrupacion son bulk y no se propagan por vinculación.
    if (scope === 'articulo') {
      const artId = Number(scopeIdStr);
      // Propaga también desde manuales (id < 0)
      if (Number.isFinite(artId) && artId !== 0) {
        if (precioManualVal !== null) {
          propagatePrecioManual({ bizId, articleId: artId, precioManual: precioManualVal })
            .catch(e => console.warn('[savePriceConfig] propagatePrecioManual falló:', e.message));
        } else if (borrarManual) {
          // Borrar el precio manual también se propaga: si A,B,C,D están vinculados
          // por precio y se borra el de C, los otros 3 deben quedar sin precio manual
          // también (mismo criterio que fijar un valor nuevo).
          propagatePrecioManual({ bizId, articleId: artId, precioManual: null })
            .catch(e => console.warn('[savePriceConfig] propagatePrecioManual (borrado) falló:', e.message));
        }
      }
    }

    return res.json({
      ok: true,
      scope,
      scopeId: scopeIdStr,
      objetivo: objetivoVal,
      precioManual: precioManualVal,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[savePriceConfig]', e);
    next(e);
  } finally {
    client.release();
  }
};

/* ══════════════════════════════════════════════════════════════
   DELETE /api/businesses/:businessId/article-price-config
   Body: { scope, scopeId }
   scope='all' → borrar todos (para deshacer)
══════════════════════════════════════════════════════════════ */
exports.deletePriceConfig = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    const { scope, scopeId } = req.body || {};

    if (!bizId || !scope) {
      return res.status(400).json({ ok: false, error: 'params_invalidos' });
    }

    if (scope === 'all') {
      await pool.query(
        `DELETE FROM article_price_config WHERE business_id = $1`,
        [bizId]
      );
      return res.json({ ok: true });
    }

    if (scopeId == null) {
      return res.status(400).json({ ok: false, error: 'scopeId_requerido' });
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
         COALESCE(ir.nombre, i.rubro, 'Sin rubro') AS rubro,
         MAX(pi.fecha) AS fecha_ultima_compra,
         COUNT(DISTINCT r.article_id)::int AS en_recetas,
         json_agg(DISTINCT jsonb_build_object(
           'article_id', r.article_id,
           'nombre', COALESCE(a.name, r.nombre, 'Artículo #' || r.article_id::text)
         )) FILTER (WHERE r.article_id IS NOT NULL) AS recetas_info
       FROM receta_items ri
       JOIN recetas r   ON r.id = ri.receta_id AND r.business_id = $1 AND r.active = TRUE
         AND r.article_id IS NOT NULL   -- solo recetas de artículo: un insumo usado
                                         -- únicamente adentro de OTRO elaborado no cuenta
                                         -- como "en receta" acá (quedaba con 0 recetas)
       JOIN insumos i   ON i.id = ri.insumo_id AND i.es_elaborado IS NOT TRUE
                                         -- los elaborados no se compran (tienen receta
                                         -- propia) — no aplica alertarlos por compra vencida
       LEFT JOIN insumo_rubros ir ON ir.business_id = i.business_id AND ir.codigo::text = i.rubro
       LEFT JOIN app_articles a ON a.id = r.article_id AND a.business_id = $1
       LEFT JOIN purchase_items pi ON pi.insumo_id = i.id AND pi.precio > 0
       WHERE ri.tipo_costo != 'nulo'
       GROUP BY i.id, i.nombre, i.unidad_med, ir.nombre
       HAVING
         MAX(pi.fecha) IS NOT NULL
         AND MAX(pi.fecha) < CURRENT_DATE - ($2 || ' weeks')::interval
       ORDER BY rubro ASC, fecha_ultima_compra ASC NULLS FIRST, i.nombre ASC`,
      [bizId, alertaSemanas]
    );

    return res.json({
      ok: true,
      alertaSemanas,
      total: rows.length,
      insumos: rows.map(r => ({
        insumoId: Number(r.insumo_id),
        nombre: r.insumo_nombre,
        unidadMed: r.unidad_med,
        rubro: r.rubro,
        fechaUltimaCompra: r.fecha_ultima_compra
          ? String(r.fecha_ultima_compra).slice(0, 10)
          : null,
        enRecetas: r.en_recetas,
        // Array de { article_id, nombre } para mostrar en el front
        recetas: (r.recetas_info || []).map(rec => ({
          articleId: Number(rec.article_id),
          nombre: rec.nombre,
        })),
      })),
    });
  } catch (e) {
    console.error('[getRecetasAlertas]', e);
    next(e);
  }
};

exports.bulkSavePriceConfig = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const bizId = Number(req.params.businessId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    const uid = req.user?.id || null;

    const { updates = [], deletes = [] } = req.body || {};

    await client.query('BEGIN');

    // Guardar precios manuales
    for (const { artId, precioManual } of updates) {
      const id = Number(artId);
      if (!Number.isFinite(id) || id === 0) continue;

      // Precio ANTES, para el historial de cambios.
      const { rows: antesRows } = await client.query(
        `SELECT precio_manual FROM article_price_config
          WHERE business_id = $1 AND scope = 'articulo' AND scope_id = $2 AND list_id IS NULL`,
        [bizId, String(id)]
      );
      const precioAntes = antesRows[0]?.precio_manual != null ? Number(antesRows[0].precio_manual) : null;
      const precioDespues = Number(precioManual);

      await client.query(
        `INSERT INTO article_price_config
           (business_id, scope, scope_id, list_id, precio_manual, updated_at)
         VALUES ($1, 'articulo', $2, NULL, $3, NOW())
         ON CONFLICT (business_id, scope, scope_id, COALESCE(list_id, 0))
         DO UPDATE SET precio_manual = EXCLUDED.precio_manual, updated_at = NOW()`,
        [bizId, String(id), precioDespues]
      );

      if (precioAntes !== precioDespues) {
        await logAudit(client, {
          userId: uid, businessId: bizId, entityType: 'precio_manual', entityId: id,
          action: 'update',
          diff: { before: { precioManual: precioAntes }, after: { precioManual: precioDespues } },
        });
      }
    }

    // Borrar precios manuales
    for (const { artId } of deletes) {
      const id = Number(artId);
      if (!Number.isFinite(id) || id === 0) continue;

      const { rows: antesRows } = await client.query(
        `SELECT precio_manual FROM article_price_config
          WHERE business_id = $1 AND scope = 'articulo' AND scope_id = $2 AND list_id IS NULL`,
        [bizId, String(id)]
      );
      const precioAntes = antesRows[0]?.precio_manual != null ? Number(antesRows[0].precio_manual) : null;

      await client.query(
        `UPDATE article_price_config
           SET precio_manual = NULL, updated_at = NOW()
         WHERE business_id = $1 AND scope = 'articulo' AND scope_id = $2`,
        [bizId, String(id)]
      );
      // Limpiar filas vacías
      await client.query(
        `DELETE FROM article_price_config
         WHERE business_id = $1 AND scope = 'articulo' AND scope_id = $2
           AND objetivo_pct IS NULL AND precio_manual IS NULL`,
        [bizId, String(id)]
      );

      if (precioAntes != null) {
        await logAudit(client, {
          userId: uid, businessId: bizId, entityType: 'precio_manual', entityId: id,
          action: 'delete',
          diff: { before: { precioManual: precioAntes }, after: { precioManual: null } },
        });
      }
    }

    await client.query('COMMIT');
    return res.json({ ok: true, updated: updates.length, deleted: deletes.length });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[bulkSavePriceConfig]', e);
    next(e);
  } finally {
    client.release();
  }
};