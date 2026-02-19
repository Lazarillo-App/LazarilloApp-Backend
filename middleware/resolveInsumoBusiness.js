// middleware/resolveInsumoBusiness.js
//
// Los insumos son globales a la organización — siempre viven en el negocio
// principal (el más antiguo, created_from = 'manual').
//
// Este middleware intercepta cualquier request de insumos que venga de un
// subnegocio y reemplaza req.business con el negocio principal de la org,
// de forma transparente para el controller.

const pool = require('../config/db');

// Cache en memoria: subbizId → principalBizId (se limpia al reiniciar)
const orgPrincipalCache = new Map();

async function resolveInsumoBusiness(req, res, next) {
  try {
    const biz = req.business;

    // Si no hay negocio cargado, o no es un subnegocio, pasar directo
    if (!biz?.id) return next();

    // Solo redirigir subnegocios (created_from = 'from_group')
    console.log(`[resolveInsumoBusiness] biz.id=${biz.id} created_from=${biz.created_from}`);
    if (biz.created_from !== 'from_group') return next();

    const subBizId = biz.id;

    // Usar cache si ya lo resolvimos antes
    if (orgPrincipalCache.has(subBizId)) {
      const cached = orgPrincipalCache.get(subBizId);
      if (cached) {
        req.business = cached;
        req._insumosResolvedFrom = subBizId;
      }
      return next();
    }

    // Buscar el negocio principal de la misma organización
    // El principal es el más antiguo con created_from != 'from_group'
    const { rows } = await pool.query(
      `SELECT b.*
       FROM app_businesses b
       WHERE b.organization_id = (
         SELECT organization_id FROM app_businesses WHERE id = $1
       )
       AND b.created_from != 'from_group'
       ORDER BY b.created_at ASC
       LIMIT 1`,
      [subBizId]
    );

    if (rows.length > 0) {
      const principal = rows[0];
      orgPrincipalCache.set(subBizId, principal);
      req.business = principal;
      req._insumosResolvedFrom = subBizId;
      console.log(
        `[resolveInsumoBusiness] Subnegocio ${subBizId} → principal ${principal.id} (${principal.name})`
      );
    } else {
      // No encontró principal — dejar el negocio como está
      orgPrincipalCache.set(subBizId, null);
      console.warn(`[resolveInsumoBusiness] No se encontró principal para subnegocio ${subBizId}`);
    }

    next();
  } catch (e) {
    console.error('[resolveInsumoBusiness] Error:', e);
    next(e);
  }
}

// Limpiar cache (útil si se crean nuevos negocios sin reiniciar)
function clearInsumosBusinessCache() {
  orgPrincipalCache.clear();
}

module.exports = { resolveInsumoBusiness, clearInsumosBusinessCache };