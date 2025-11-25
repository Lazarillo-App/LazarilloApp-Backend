// controllers/insumosGroupsController.js
/* eslint-disable no-console */
const insumoGroupsRepo = require('../repos/insumoGroupsRepo');

/**
 * Igual que en insumosController: obtenemos el businessId del request.
 */
function getBusinessIdFromReq(req) {
  if (req.business && req.business.id) return Number(req.business.id);
  if (req.user && req.user.active_business_id) return Number(req.user.active_business_id);

  const hdr = req.header('X-Business-Id') || req.query.businessId;
  return hdr ? Number(hdr) : null;
}

/**
 * GET /api/insumos/groups
 */
exports.list = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const groups = await insumoGroupsRepo.listForBusiness(businessId, { withItems: true });
    return res.json({ ok: true, data: groups });
  } catch (e) {
    console.error('insumosGroupsController.list error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal' });
  }
};

/**
 * GET /api/insumos/groups/:id
 */
exports.getOne = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);
    const groupId = Number(req.params.id);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }
    if (!Number.isFinite(groupId)) {
      return res.status(400).json({ ok: false, error: 'ID de grupo inválido' });
    }

    const group = await insumoGroupsRepo.getOne(businessId, groupId);
    if (!group) {
      return res.status(404).json({ ok: false, error: 'Grupo de insumos no encontrado' });
    }

    return res.json({ ok: true, data: group });
  } catch (e) {
    console.error('insumosGroupsController.getOne error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal' });
  }
};

/**
 * POST /api/insumos/groups
 * Body: { nombre, descripcion?, esFavorita?, insumoIds?: number[] }
 */
exports.create = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const { nombre, descripcion, esFavorita, insumoIds } = req.body || {};
    if (!nombre || String(nombre).trim() === '') {
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio' });
    }

    const group = await insumoGroupsRepo.createGroup({
      businessId,
      nombre: String(nombre).trim(),
      descripcion: descripcion ?? null,
      esFavorita: !!esFavorita,
      insumoIds: Array.isArray(insumoIds) ? insumoIds : [],
    });

    return res.status(201).json({ ok: true, data: group });
  } catch (e) {
    console.error('insumosGroupsController.create error:', e);
    // ⚠️ posible conflicto por nombre duplicado
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ya existe una agrupación con ese nombre en este negocio' });
    }
    return res.status(500).json({ ok: false, error: e.message || 'internal' });
  }
};

/**
 * PUT /api/insumos/groups/:id
 * Body: { nombre?, descripcion?, esFavorita? }
 */
exports.update = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);
    const groupId = Number(req.params.id);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }
    if (!Number.isFinite(groupId)) {
      return res.status(400).json({ ok: false, error: 'ID de grupo inválido' });
    }

    const { nombre, descripcion, esFavorita } = req.body || {};
    const group = await insumoGroupsRepo.updateGroup({
      businessId,
      groupId,
      nombre,
      descripcion,
      esFavorita,
    });

    if (!group) {
      return res.status(404).json({ ok: false, error: 'Grupo de insumos no encontrado' });
    }

    return res.json({ ok: true, data: group });
  } catch (e) {
    console.error('insumosGroupsController.update error:', e);
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ya existe una agrupación con ese nombre en este negocio' });
    }
    return res.status(500).json({ ok: false, error: e.message || 'internal' });
  }
};

/**
 * PUT /api/insumos/groups/:id/items
 * Body: { insumoIds: number[] }
 */
exports.replaceItems = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);
    const groupId = Number(req.params.id);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }
    if (!Number.isFinite(groupId)) {
      return res.status(400).json({ ok: false, error: 'ID de grupo inválido' });
    }

    const { insumoIds } = req.body || {};
    const arr = Array.isArray(insumoIds) ? insumoIds : [];

    const group = await insumoGroupsRepo.replaceGroupItems({
      businessId,
      groupId,
      insumoIds: arr,
    });

    return res.json({ ok: true, data: group });
  } catch (e) {
    console.error('insumosGroupsController.replaceItems error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal' });
  }
};

/**
 * DELETE /api/insumos/groups/:id
 */
exports.remove = async (req, res) => {
  try {
    const businessId = getBusinessIdFromReq(req);
    const groupId = Number(req.params.id);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }
    if (!Number.isFinite(groupId)) {
      return res.status(400).json({ ok: false, error: 'ID de grupo inválido' });
    }

    const ok = await insumoGroupsRepo.deleteGroup(businessId, groupId);
    if (!ok) {
      return res.status(404).json({ ok: false, error: 'Grupo de insumos no encontrado' });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('insumosGroupsController.remove error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal' });
  }
};
