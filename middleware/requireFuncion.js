// middleware/requireFuncion.js
// Funciones por negocio (Diego 17/11/2026): lo que Lazarillo ocultó para un negocio (área o función,
// ajuste modulos_ocultos) también se corta en el servidor, no solo en la pantalla. Responde 403
// «funcion_oculta» cuando TODAS las funciones pedidas están ocultas (o su área). Los negocios cuyo
// dueño es super usuario nunca tienen nada oculto (lo resuelve ajustesService.efectivos).
'use strict';

const ajustes = require('../services/ajustesService');

const AREA_DE = {
  tableros: 'operacion', rrhh: 'operacion',
  resultados: 'rentabilidad', recetas: 'rentabilidad', stock: 'rentabilidad', compras: 'rentabilidad',
  conciliacion: 'administracion', 'movimientos-bancarios': 'administracion', clientes: 'administracion',
};

// Caché corta (30 s) por negocio y usuario: son dos consultas chicas, pero estas rutas se llaman seguido.
const cache = new Map();
const TTL = 30 * 1000;
async function ocultosDe(userId, businessId) {
  const k = `${businessId}:${userId || 0}`;
  const hit = cache.get(k);
  if (hit && hit.exp > Date.now()) return hit.v;
  const ef = await ajustes.efectivos(userId, businessId);
  const v = Array.isArray(ef.modulos_ocultos) ? ef.modulos_ocultos : [];
  cache.set(k, { v, exp: Date.now() + TTL });
  if (cache.size > 2000) cache.clear();
  return v;
}

function todasOcultas(ocultos, ids) {
  if (!ocultos.length) return false;
  return ids.every((id) => ocultos.includes(id) || ocultos.includes(AREA_DE[id]));
}

function requireFuncion(...ids) {
  return async (req, res, next) => {
    try {
      const bid = Number(req.params?.businessId || req.businessId || req.business?.id);
      if (!Number.isFinite(bid) || bid <= 0) return next();
      const ocultos = await ocultosDe(req.user?.id, bid);
      if (todasOcultas(ocultos, ids)) return res.status(403).json({ ok: false, error: 'funcion_oculta' });
      return next();
    } catch (e) {
      // Ante un error leyendo los ajustes no se corta nada (mejor mostrar que romper).
      console.warn('[requireFuncion]', e?.message);
      return next();
    }
  };
}

function limpiarCache() { cache.clear(); }

module.exports = { requireFuncion, todasOcultas, limpiarCache, AREA_DE };
