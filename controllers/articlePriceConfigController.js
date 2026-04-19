// controllers/articlePriceConfigController.js
'use strict';

const pool = require('../config/db');
const { propagatePrecioManual, propagateObjetivo } = require('../services/linkPropagation');

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
      `SELECT scope, scope_id, objetivo_pct, precio_manual
         FROM article_price_config
        WHERE business_id = $1`,
      [bizId]
    );

    const byArticle = {};
    const byRubro = {};
    const byAgrupacion = {};

    for (const r of rows) {
      const entry = {
        objetivo: r.objetivo_pct != null ? Number(r.objetivo_pct) : null,
        precioManual: r.precio_manual != null ? Number(r.precio_manual) : null,
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
  const client = await pool.connect();
  try {
    const bizId = Number(req.params.businessId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const {
      scope,
      scopeId,
      objetivo,
      precioManual,
      articleIds,
      pisarTodo = false,
      excluirIds = [],   // ← NUEVO: IDs a excluir cuando el usuario eligió "respetar individuales"
      nuevoGlobal,       // ← NUEVO: valor del nuevo global (solo para scope='global')
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
             AND precio_manual IS NULL`,
          [bizId]
        );

        console.log(`[savePriceConfig] scope=global pisarTodo → limpiados todos los objetivos del negocio ${bizId}`);
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

    await client.query('BEGIN');

    // ── Upsert del registro principal (scope + scopeId) ──────────────────────
    if (objetivoVal !== null || precioManualVal !== null) {
      await client.query(
        `INSERT INTO article_price_config
           (business_id, scope, scope_id, objetivo_pct, precio_manual, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (business_id, scope, scope_id)
         DO UPDATE SET
           objetivo_pct  = CASE WHEN $4::numeric IS NOT NULL
                           THEN EXCLUDED.objetivo_pct
                           ELSE article_price_config.objetivo_pct END,
           precio_manual = CASE WHEN $5::numeric IS NOT NULL
                           THEN EXCLUDED.precio_manual
                           ELSE article_price_config.precio_manual END,
           updated_at    = NOW()`,
        [bizId, scope, scopeIdStr, objetivoVal, precioManualVal]
      );
    } else if (objetivo === null && precioManual === null) {
      // Borrar selectivamente según qué keys vinieron en el body
      const bodyKeys = Object.keys(req.body || {});
      const borrarManual = bodyKeys.includes('precioManual');
      const borrarObjetivo = bodyKeys.includes('objetivo');

      if (borrarManual && borrarObjetivo) {
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
      }
    }

    // ── Override masivo en artículos cuando es agrupación/rubro con objetivo ──
    if (objetivoVal !== null && Array.isArray(articleIds) && articleIds.length > 0) {

      let idsToUpdate = articleIds.map(Number).filter(id => Number.isFinite(id) && id > 0);

      if (pisarTodo) {
        // Pisar todo: no excluir ninguno, se aplica el objetivo a todos
        // (el usuario eligió "Aplicar a todos" en el diálogo de confirmación)
        console.log(`[savePriceConfig] pisarTodo=true → aplicando a ${idsToUpdate.length} artículos`);

      } else {
        // ── LÓGICA CORREGIDA ──────────────────────────────────────────────────
        // Antes: el backend detectaba artículos con cualquier override y los excluía.
        // Problema: la detección era inconsistente con lo que el frontend mostraba.
        //
        // Ahora: el FRONTEND ya hizo la detección y nos manda la lista exacta de
        // IDs a excluir en excluirIds[]. El backend los respeta sin re-detectar.
        // Esto garantiza que frontend y backend están perfectamente sincronizados.
        //
        // Si excluirIds viene vacío = el usuario eligió no excluir nada
        // Si excluirIds tiene IDs   = excluir exactamente esos artículos

        const excluirSet = new Set(
          (excluirIds || []).map(Number).filter(id => Number.isFinite(id) && id > 0)
        );

        if (excluirSet.size > 0) {
          idsToUpdate = idsToUpdate.filter(id => !excluirSet.has(id));
          console.log(`[savePriceConfig] excluirIds=${excluirSet.size} → actualizando ${idsToUpdate.length}/${articleIds.length} artículos`);
        } else {
          // Sin exclusiones explícitas del frontend: comportamiento conservador
          // Solo excluir artículos que tienen AMBOS objetivo Y precio_manual
          // (configuración muy específica que claramente el usuario hizo a propósito)
          const { rows: muyEspecificos } = await client.query(
            `SELECT scope_id FROM article_price_config
             WHERE business_id = $1
               AND scope = 'articulo'
               AND objetivo_pct IS NOT NULL
               AND precio_manual IS NOT NULL
               AND scope_id = ANY($2::text[])`,
            [bizId, idsToUpdate.map(String)]
          );
          const muyEspecificosSet = new Set(muyEspecificos.map(r => Number(r.scope_id)));
          if (muyEspecificosSet.size > 0) {
            idsToUpdate = idsToUpdate.filter(id => !muyEspecificosSet.has(id));
            console.log(`[savePriceConfig] conservador: excluyendo ${muyEspecificosSet.size} con objetivo+manual`);
          }
        }
      }

      // Aplicar el objetivo a todos los IDs que pasaron el filtro
      for (const id of idsToUpdate) {
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

      console.log(`[savePriceConfig] ${scope}/${scopeIdStr} → objetivo=${objetivoVal}% en ${idsToUpdate.length}/${articleIds.length} artículos (pisarTodo=${pisarTodo})`);
    }

    await client.query('COMMIT');

    // ── Propagación a artículos vinculados ─────────────────────────────────
    // Solo propagamos cuando es scope='articulo' (cambio individual).
    // Los cambios de rubro/agrupacion son bulk y no se propagan por vinculación.
    if (scope === 'articulo') {
      const artId = Number(scopeIdStr);
      if (Number.isFinite(artId) && artId > 0) {
        if (precioManualVal !== null) {
          propagatePrecioManual({ bizId, articleId: artId, precioManual: precioManualVal })
            .catch(e => console.warn('[savePriceConfig] propagatePrecioManual falló:', e.message));
        }
        if (objetivoVal !== null) {
          propagateObjetivo({ bizId, articleId: artId, objetivo: objetivoVal })
            .catch(e => console.warn('[savePriceConfig] propagateObjetivo falló:', e.message));
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
         MAX(pi.fecha) AS fecha_ultima_compra,
         COUNT(DISTINCT r.article_id)::int AS en_recetas,
         array_agg(DISTINCT r.article_id) AS article_ids
       FROM receta_items ri
       JOIN recetas r   ON r.id = ri.receta_id AND r.business_id = $1 AND r.active = TRUE
       JOIN insumos i   ON i.id = ri.insumo_id
       LEFT JOIN purchase_items pi ON pi.insumo_id = i.id AND pi.precio > 0
       WHERE ri.tipo_costo != 'nulo'
       GROUP BY i.id, i.nombre, i.unidad_med
       HAVING
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
        insumoId: Number(r.insumo_id),
        nombre: r.insumo_nombre,
        unidadMed: r.unidad_med,
        fechaUltimaCompra: r.fecha_ultima_compra
          ? String(r.fecha_ultima_compra).slice(0, 10)
          : null,
        enRecetas: r.en_recetas,
        articleIds: (r.article_ids || []).map(Number),
      })),
    });
  } catch (e) {
    console.error('[getRecetasAlertas]', e);
    next(e);
  }
};