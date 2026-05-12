// controllers/branchesController.js
// Gestión de sucursales (app_branches)
// Locales físicos de un mismo negocio — comparten artículos/insumos
// pero tienen ventas y compras separadas por branch_id
'use strict';

const pool = require('../config/db');

const trim = (s) =>
  s === undefined || s === null || String(s).trim() === ''
    ? null
    : String(s).trim();

/**
 * GET /api/businesses/:bizId/branches
 * Lista todas las sucursales del negocio.
 */
exports.listBranches = async (req, res, next) => {
  try {
    const bizId = Number(req.params.bizId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'bizId requerido' });

    const { rows } = await pool.query(
      `SELECT
         id, business_id, name, color, logo_url,
         address, contacts, props,
         created_at, updated_at
       FROM app_branches
       WHERE business_id = $1
       ORDER BY created_at ASC`,
      [bizId]
    );

    res.json({ ok: true, branches: rows });
  } catch (e) {
    console.error('[branches] listBranches:', e);
    next(e);
  }
};

/**
 * GET /api/businesses/:bizId/branches/has-branches
 * Devuelve si el negocio tiene sucursales (para que el front decida mostrar selector).
 * IMPORTANTE: esta ruta debe registrarse ANTES de /:branchId en el router.
 */
exports.hasBranches = async (req, res, next) => {
  try {
    const bizId = Number(req.params.bizId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'bizId requerido' });

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM app_branches WHERE business_id = $1`,
      [bizId]
    );
    const count = rows[0]?.count ?? 0;
    res.json({ ok: true, hasBranches: count > 0, count });
  } catch (e) {
    console.error('[branches] hasBranches:', e);
    next(e);
  }
};

/**
 * GET /api/businesses/:bizId/branches/:branchId
 */
exports.getBranch = async (req, res, next) => {
  try {
    const bizId    = Number(req.params.bizId);
    const branchId = Number(req.params.branchId);

    const { rows } = await pool.query(
      `SELECT id, business_id, name, color, logo_url,
              address, contacts, props, created_at, updated_at
       FROM app_branches
       WHERE id = $1 AND business_id = $2`,
      [branchId, bizId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Sucursal no encontrada' });

    res.json({ ok: true, branch: rows[0] });
  } catch (e) {
    console.error('[branches] getBranch:', e);
    next(e);
  }
};

/**
 * POST /api/businesses/:bizId/branches
 * Crea una sucursal. Hereda color y logo del negocio padre si no se especifican.
 * Body: { name, color?, logo_url?, address?, contacts?, props? }
 */
exports.createBranch = async (req, res, next) => {
  try {
    const bizId = Number(req.params.bizId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'bizId requerido' });

    const name = trim(req.body?.name);
    if (!name) return res.status(400).json({ ok: false, error: 'El nombre es requerido' });

    // Traer defaults del negocio padre
    const { rows: parentRows } = await pool.query(
      `SELECT props FROM app_businesses WHERE id = $1`, [bizId]
    );
    if (!parentRows[0]) return res.status(404).json({ ok: false, error: 'Negocio no encontrado' });

    const parentProps = parentRows[0].props || {};

    const color    = trim(req.body?.color)    || parentProps?.branding?.primary || '#1976d2';
    const logo_url = trim(req.body?.logo_url) || parentProps?.branding?.logo_url || null;
    const address  = req.body?.address  ?? parentProps?.address  ?? {};
    const contacts = req.body?.contacts ?? parentProps?.contact  ?? {};
    const props    = req.body?.props    ?? {};

    const { rows } = await pool.query(
      `INSERT INTO app_branches
         (business_id, name, color, logo_url, address, contacts, props)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [bizId, name, color, logo_url,
       JSON.stringify(address),
       JSON.stringify(contacts),
       JSON.stringify(props)]
    );

    res.status(201).json({ ok: true, branch: rows[0] });
  } catch (e) {
    console.error('[branches] createBranch:', e);
    next(e);
  }
};

/**
 * PATCH /api/businesses/:bizId/branches/:branchId
 * Actualización parcial — solo toca los campos enviados.
 * Body: { name?, color?, logo_url?, address?, contacts?, props? }
 */
exports.updateBranch = async (req, res, next) => {
  try {
    const bizId    = Number(req.params.bizId);
    const branchId = Number(req.params.branchId);

    const { rows: curr } = await pool.query(
      `SELECT * FROM app_branches WHERE id = $1 AND business_id = $2`,
      [branchId, bizId]
    );
    if (!curr[0]) return res.status(404).json({ ok: false, error: 'Sucursal no encontrada' });

    const c = curr[0];
    const name     = trim(req.body?.name)     ?? c.name;
    const color    = trim(req.body?.color)    ?? c.color;
    const logo_url = req.body?.logo_url !== undefined ? trim(req.body.logo_url) : c.logo_url;
    const address  = req.body?.address  !== undefined ? req.body.address  : c.address;
    const contacts = req.body?.contacts !== undefined ? req.body.contacts : c.contacts;
    // props: merge profundo para no pisar claves existentes
    const props    = req.body?.props !== undefined
      ? { ...c.props, ...req.body.props }
      : c.props;

    const { rows } = await pool.query(
      `UPDATE app_branches
       SET name=$1, color=$2, logo_url=$3, address=$4, contacts=$5, props=$6, updated_at=NOW()
       WHERE id=$7 AND business_id=$8
       RETURNING *`,
      [name, color, logo_url,
       JSON.stringify(address),
       JSON.stringify(contacts),
       JSON.stringify(props),
       branchId, bizId]
    );

    res.json({ ok: true, branch: rows[0] });
  } catch (e) {
    console.error('[branches] updateBranch:', e);
    next(e);
  }
};

/**
 * PATCH /api/businesses/:bizId/branches/main
 * Crea o actualiza la sucursal principal (is_main=true en props).
 * No toca el negocio padre — son datos completamente independientes.
 * Body: { name, logo_url?, address?, contacts?, props? }
 */
exports.updateMainBranch = async (req, res, next) => {
  try {
    const bizId = Number(req.params.bizId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'bizId requerido' });

    const name     = trim(req.body?.name);
    if (!name) return res.status(400).json({ ok: false, error: 'El nombre es requerido' });

    const logo_url = req.body?.logo_url !== undefined ? trim(req.body.logo_url) : null;
    const address  = req.body?.address  ?? {};
    const contacts = req.body?.contacts ?? {};
    const props    = { ...(req.body?.props ?? {}), is_main: true };

    // Buscar si ya existe una branch is_main para este negocio
    const { rows: existing } = await pool.query(
      `SELECT id FROM app_branches
        WHERE business_id = $1 
          AND props IS NOT NULL 
          AND (props->>'is_main')::boolean = true
        LIMIT 1`,
      [bizId]
    );

    let branch;
    if (existing.length) {
      // Actualizar existente — NO tocar color (la sucursal principal no tiene color propio)
      const { rows } = await pool.query(
        `UPDATE app_branches
            SET name=$1, logo_url=$2, address=$3, contacts=$4,
                props = props || $5::jsonb,
                updated_at = NOW()
          WHERE id=$6 AND business_id=$7
          RETURNING *`,
        [name, logo_url,
         JSON.stringify(address),
         JSON.stringify(contacts),
         JSON.stringify(props),
         existing[0].id, bizId]
      );
      branch = rows[0];
    } else {
      // Crear nueva sucursal principal
      const { rows } = await pool.query(
        `INSERT INTO app_branches
           (business_id, name, color, logo_url, address, contacts, props)
         VALUES ($1, $2, NULL, $3, $4, $5, $6)
         RETURNING *`,
        [bizId, name, logo_url,
         JSON.stringify(address),
         JSON.stringify(contacts),
         JSON.stringify(props)]
      );
      branch = rows[0];
    }

    res.json({ ok: true, branch });
  } catch (e) {
    console.error('[branches] updateMainBranch:', e);
    next(e);
  }
};

/**
 * DELETE /api/businesses/:bizId/branches/:branchId
 * Protegido: no se puede eliminar si tiene ventas o compras asociadas.
 */
exports.deleteBranch = async (req, res, next) => {
  try {
    const bizId    = Number(req.params.bizId);
    const branchId = Number(req.params.branchId);

    // Verificar ventas asociadas
    const { rows: salesCheck } = await pool.query(
      `SELECT 1 FROM sales_daily_items_branch WHERE branch_id = $1 LIMIT 1`,
      [branchId]
    );
    if (salesCheck.length > 0) {
      return res.status(409).json({
        ok: false,
        error: 'No se puede eliminar una sucursal con ventas registradas',
        code: 'BRANCH_HAS_SALES',
      });
    }

    // Verificar compras asociadas
    const { rows: purchasesCheck } = await pool.query(
      `SELECT 1 FROM purchase_items WHERE branch_id = $1 LIMIT 1`,
      [branchId]
    );
    if (purchasesCheck.length > 0) {
      return res.status(409).json({
        ok: false,
        error: 'No se puede eliminar una sucursal con compras registradas',
        code: 'BRANCH_HAS_PURCHASES',
      });
    }

    const { rowCount } = await pool.query(
      `DELETE FROM app_branches WHERE id = $1 AND business_id = $2`,
      [branchId, bizId]
    );
    if (rowCount === 0) return res.status(404).json({ ok: false, error: 'Sucursal no encontrada' });

    res.json({ ok: true, deleted: branchId });
  } catch (e) {
    console.error('[branches] deleteBranch:', e);
    next(e);
  }
};