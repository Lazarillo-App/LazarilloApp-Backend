// controllers/costoManualController.js — recargo % y deshacer en lote del costo manual de insumos
// (Diego 19/11/2026). Ver services/costoManual.js.
'use strict';

const pool = require('../config/db');
const getBusinessId = require('../utils/getBusinessId');
const { avisarAlEquipoSinEsperar } = require('../services/notificationService');
const { invalidateCacheForBiz } = require('../middleware/cacheJson');
const { aplicarCostoManual, deshacerCostoManualUno, alcanceProveedor } = require('../services/costoManual');

async function getOrgBizIds(bizId) {
  // Mismo criterio que insumosController.getOrgBizIds.
  const { rows } = await pool.query(
    `SELECT id FROM app_businesses WHERE organization_id = (SELECT organization_id FROM app_businesses WHERE id = $1)`, [bizId]);
  const ids = rows.map((r) => Number(r.id)).filter(Boolean);
  return ids.length ? ids : [Number(bizId)];
}
async function supplierBizIdDe(bizId) {
  const { resolveCredsBizId } = require('./purchasesController');
  return resolveCredsBizId(bizId);
}
const fmt = (v) => `$${Number(v || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;
const fmtPct = (p) => `${p > 0 ? '+' : ''}${Number(p).toLocaleString('es-AR', { maximumFractionDigits: 2 })}%`;
const redondear = (v) => Math.round(v * 100) / 100;

// GET /insumos/:id/recargo-alcance → { proveedor, insumos } (los de la última compra a ese proveedor)
exports.alcance = async (req, res) => {
  const id = Number(req.params.id);
  const businessId = getBusinessId(req);
  if (!businessId || !Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
  try {
    const orgBizIds = await getOrgBizIds(businessId);
    const supplierBizId = await supplierBizIdDe(businessId);
    const r = await alcanceProveedor(pool, { insumoId: id, businessId, orgBizIds, supplierBizId });
    return res.json({ ok: true, ...r });
  } catch (e) {
    console.error('costoManual.alcance error:', e);
    return res.status(500).json({ ok: false, error: 'No se pudo buscar el proveedor' });
  }
};

// POST /insumos/recargo { insumoId, pct, alcance: 'insumo' | 'proveedor' }
// Sube (o baja) el costo un X % sobre el actual. Queda como costo manual: la próxima compra lo pisa.
exports.recargo = async (req, res) => {
  const businessId = getBusinessId(req);
  const insumoId = Number(req.body?.insumoId);
  const pct = Number(String(req.body?.pct ?? '').replace(',', '.'));
  const alcance = req.body?.alcance === 'proveedor' ? 'proveedor' : 'insumo';
  if (!businessId || !Number.isFinite(insumoId)) return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
  if (!Number.isFinite(pct) || pct === 0 || pct <= -95 || pct > 1000) return res.status(400).json({ ok: false, error: 'Poné un porcentaje válido (distinto de 0)' });
  const orgBizIds = await getOrgBizIds(businessId);
  let objetivo; let proveedor = null;
  try {
    if (alcance === 'proveedor') {
      const r = await alcanceProveedor(pool, { insumoId, businessId, orgBizIds, supplierBizId: await supplierBizIdDe(businessId) });
      if (!r.proveedor) return res.status(409).json({ ok: false, error: 'Este insumo no tiene compras: no hay proveedor' });
      proveedor = r.proveedor; objetivo = r.insumos;
    } else {
      const { rows } = await pool.query(
        `SELECT i.id, i.business_id, i.nombre, COALESCE(icl.precio, i.precio_ref)::float AS precio
           FROM insumos i LEFT JOIN insumo_costos_local icl ON icl.insumo_id = i.id AND icl.business_id = $3
          WHERE i.id = $1 AND i.business_id = ANY($2::int[]) AND COALESCE(i.es_elaborado, FALSE) = FALSE`,
        [insumoId, orgBizIds, businessId]);
      objetivo = rows;
    }
  } catch (e) {
    console.error('costoManual.recargo alcance error:', e);
    return res.status(500).json({ ok: false, error: 'No se pudo aplicar el recargo' });
  }
  objetivo = (objetivo || []).filter((x) => Number(x.precio) > 0);
  if (!objetivo.length) return res.status(409).json({ ok: false, error: 'No hay costos para recargar (sin precio cargado)' });

  const client = await pool.connect();
  const items = [];
  try {
    await client.query('BEGIN');
    for (const ins of objetivo) {
      const { rows: lock } = await client.query(`SELECT id, business_id FROM insumos WHERE id = $1 FOR UPDATE`, [ins.id]);
      if (!lock[0]) continue;
      const nuevo = redondear(Number(ins.precio) * (1 + pct / 100));
      await aplicarCostoManual(client, lock[0], nuevo);
      items.push({ id: Number(ins.id), nombre: ins.nombre, antes: Number(ins.precio), despues: nuevo });
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* nada */ }
    console.error('costoManual.recargo error:', e);
    return res.status(500).json({ ok: false, error: 'No se pudo aplicar el recargo' });
  } finally {
    client.release();
  }
  for (const b of new Set([businessId, ...objetivo.map((x) => Number(x.business_id))])) invalidateCacheForBiz(b);
  const uno = items.length === 1;
  avisarAlEquipoSinEsperar({
    businessId, actorUserId: req.user?.id, type: 'insumo_update',
    title: uno
      ? `Recargo ${fmtPct(pct)}: ${items[0].nombre} ${fmt(items[0].antes)} → ${fmt(items[0].despues)}`
      : `Recargo ${fmtPct(pct)}: ${items.length} insumos de ${proveedor?.nombre || 'un proveedor'}`,
    message: 'Costo manual: vale hasta la próxima compra de cada insumo.',
    metadata: { kind: 'insumo_update', scope: 'insumo', ids: items.map((x) => x.id), costo_manual: true, recargo_pct: pct, proveedor_id: proveedor?.id ?? null },
  });
  return res.json({ ok: true, pct, proveedor, items });
};

// POST /insumos/costo-manual/deshacer-lote { ids } — deshace el costo manual de varios insumos (el
// «Deshacer ›» de un recargo a todo un proveedor). Los que ya no estaban manuales se saltean.
exports.deshacerLote = async (req, res) => {
  const businessId = getBusinessId(req);
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isFinite))].slice(0, 500);
  if (!businessId || !ids.length) return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
  const orgBizIds = await getOrgBizIds(businessId);
  const client = await pool.connect();
  const hechos = [];
  try {
    await client.query('BEGIN');
    for (const id of ids) {
      const r = await deshacerCostoManualUno(client, id, orgBizIds);
      if (r) hechos.push(r);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* nada */ }
    console.error('costoManual.deshacerLote error:', e);
    return res.status(500).json({ ok: false, error: 'No se pudo deshacer' });
  } finally {
    client.release();
  }
  if (!hechos.length) return res.status(409).json({ ok: false, error: 'Ninguno sigue con costo manual (se deshizo o entró una compra)' });
  for (const b of orgBizIds) invalidateCacheForBiz(b);
  avisarAlEquipoSinEsperar({
    businessId, actorUserId: req.user?.id, type: 'insumo_update',
    title: hechos.length === 1
      ? `Costo manual deshecho: ${hechos[0].nombre} ${fmt(hechos[0].antes)} → ${fmt(hechos[0].despues)}`
      : `Costo manual deshecho: ${hechos.length} insumos`,
    message: 'Vuelven al costo de sus compras (o al precio de antes si no tienen).',
    metadata: { kind: 'insumo_update', scope: 'insumo', ids: hechos.map((h) => h.id) },
  });
  return res.json({ ok: true, items: hechos, saltados: ids.length - hechos.length });
};
