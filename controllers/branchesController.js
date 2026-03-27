// controllers/branchesController.js
const pool = require("../config/db");

// ─── Helpers ────────────────────────────────────────────────────────────────

const normalizeEmpty = (s) =>
  s === undefined || s === null || String(s).trim() === ""
    ? null
    : String(s).trim();

// ─── GET /api/businesses/:bizId/branches ────────────────────────────────────
// Lista todas las sucursales de un negocio
async function listBranches(req, res) {
  const { bizId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, business_id, name, color, logo_url, address, contacts, props,
              created_at, updated_at
       FROM app_branches
       WHERE business_id = $1
       ORDER BY created_at ASC`,
      [bizId]
    );
    res.json({ branches: rows });
  } catch (err) {
    console.error("[branches] listBranches:", err);
    res.status(500).json({ error: "Error al listar sucursales" });
  }
}

// ─── GET /api/businesses/:bizId/branches/:branchId ──────────────────────────
async function getBranch(req, res) {
  const { bizId, branchId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, business_id, name, color, logo_url, address, contacts, props,
              created_at, updated_at
       FROM app_branches
       WHERE id = $1 AND business_id = $2`,
      [branchId, bizId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Sucursal no encontrada" });
    res.json({ branch: rows[0] });
  } catch (err) {
    console.error("[branches] getBranch:", err);
    res.status(500).json({ error: "Error al obtener sucursal" });
  }
}

// ─── POST /api/businesses/:bizId/branches ───────────────────────────────────
// Crea una nueva sucursal. Hereda del negocio padre lo que no se especifique.
async function createBranch(req, res) {
  const { bizId } = req.params;
  const { name, color, logo_url, address, contacts, props } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "El nombre es requerido" });
  }

  try {
    // Traer datos del negocio padre para heredar defaults
    const parentRes = await pool.query(
      "SELECT props FROM app_businesses WHERE id = $1",
      [bizId]
    );
    if (!parentRes.rows[0]) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }
    const parentProps = parentRes.rows[0].props || {};

    const branchColor = normalizeEmpty(color) || parentProps?.branding?.primary || "#1976d2";
    const branchLogo  = normalizeEmpty(logo_url) || parentProps?.branding?.logo_url || null;
    const branchAddr  = address  || parentProps?.address  || {};
    const branchCont  = contacts || parentProps?.contact  || {};
    const branchProps = props    || {};

    const { rows } = await pool.query(
      `INSERT INTO app_branches
         (business_id, name, color, logo_url, address, contacts, props)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        bizId,
        String(name).trim(),
        branchColor,
        branchLogo,
        JSON.stringify(branchAddr),
        JSON.stringify(branchCont),
        JSON.stringify(branchProps),
      ]
    );
    res.status(201).json({ branch: rows[0] });
  } catch (err) {
    console.error("[branches] createBranch:", err);
    res.status(500).json({ error: "Error al crear sucursal" });
  }
}

// ─── PATCH /api/businesses/:bizId/branches/:branchId ────────────────────────
// Actualización parcial: solo toca los campos enviados
async function updateBranch(req, res) {
  const { bizId, branchId } = req.params;
  const { name, color, logo_url, address, contacts, props } = req.body;

  try {
    const existing = await pool.query(
      "SELECT * FROM app_branches WHERE id = $1 AND business_id = $2",
      [branchId, bizId]
    );
    if (!existing.rows[0]) {
      return res.status(404).json({ error: "Sucursal no encontrada" });
    }
    const curr = existing.rows[0];

    const newName     = normalizeEmpty(name)      ?? curr.name;
    const newColor    = normalizeEmpty(color)      ?? curr.color;
    const newLogoUrl  = logo_url !== undefined ? normalizeEmpty(logo_url) : curr.logo_url;
    const newAddress  = address  !== undefined ? address  : curr.address;
    const newContacts = contacts !== undefined ? contacts : curr.contacts;
    const newProps    = props    !== undefined
      ? { ...curr.props, ...props }  // merge profundo de props
      : curr.props;

    const { rows } = await pool.query(
      `UPDATE app_branches
       SET name = $1, color = $2, logo_url = $3,
           address = $4, contacts = $5, props = $6
       WHERE id = $7 AND business_id = $8
       RETURNING *`,
      [
        newName,
        newColor,
        newLogoUrl,
        JSON.stringify(newAddress),
        JSON.stringify(newContacts),
        JSON.stringify(newProps),
        branchId,
        bizId,
      ]
    );
    res.json({ branch: rows[0] });
  } catch (err) {
    console.error("[branches] updateBranch:", err);
    res.status(500).json({ error: "Error al actualizar sucursal" });
  }
}

// ─── DELETE /api/businesses/:bizId/branches/:branchId ───────────────────────
// Eliminar solo si no tiene ventas asociadas (protección de datos)
async function deleteBranch(req, res) {
  const { bizId, branchId } = req.params;
  try {
    // Verificar si tiene ventas
    const salesCheck = await pool.query(
      "SELECT 1 FROM sales_daily_items_branch WHERE branch_id = $1 LIMIT 1",
      [branchId]
    );
    if (salesCheck.rows.length > 0) {
      return res.status(409).json({
        error: "No se puede eliminar una sucursal con ventas registradas",
        code: "BRANCH_HAS_SALES",
      });
    }

    const { rowCount } = await pool.query(
      "DELETE FROM app_branches WHERE id = $1 AND business_id = $2",
      [branchId, bizId]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: "Sucursal no encontrada" });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[branches] deleteBranch:", err);
    res.status(500).json({ error: "Error al eliminar sucursal" });
  }
}

// ─── GET /api/businesses/:bizId/branches/has-branches ───────────────────────
// Devuelve si el negocio tiene sucursales (para que el front decida mostrar el selector)
async function hasBranches(req, res) {
  const { bizId } = req.params;
  try {
    const { rows } = await pool.query(
      "SELECT COUNT(*) AS count FROM app_branches WHERE business_id = $1",
      [bizId]
    );
    res.json({ hasBranches: parseInt(rows[0].count) > 0, count: parseInt(rows[0].count) });
  } catch (err) {
    console.error("[branches] hasBranches:", err);
    res.status(500).json({ error: "Error al verificar sucursales" });
  }
}

module.exports = {
  listBranches,
  getBranch,
  createBranch,
  updateBranch,
  deleteBranch,
  hasBranches,
};