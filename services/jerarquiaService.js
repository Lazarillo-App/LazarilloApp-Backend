// services/jerarquiaService.js
// Helper centralizado para resolver el setting "invertir_jerarquia".
// Es la ÚNICA fuente de verdad para esa decisión.

const pool = require('../config/db');

/**
 * Devuelve el flag invertir_jerarquia para un biz.
 * Prioridad: organización (settings) > biz (props legacy).
 * @param {number} bizId
 * @returns {Promise<boolean>}
 */
async function getInvertirJerarquia(bizId) {
  const id = Number(bizId);
  if (!Number.isFinite(id)) return false;

  const { rows } = await pool.query(
    `SELECT
       b.props AS biz_props,
       o.settings AS org_settings
     FROM app_businesses b
     LEFT JOIN organizations o ON o.id = b.organization_id
     WHERE b.id = $1`,
    [id]
  );

  if (!rows[0]) return false;

  // Org manda si tiene el flag definido
  const orgFlag = rows[0].org_settings?.invertir_jerarquia;
  if (orgFlag === true || orgFlag === false) return orgFlag;

  // Fallback: flag legacy del biz
  return rows[0].biz_props?.invertir_jerarquia_articulos === true;
}

module.exports = {
  getInvertirJerarquia,
};