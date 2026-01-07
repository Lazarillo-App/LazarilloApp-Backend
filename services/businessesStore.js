// services/businessesStore.js
/* 
 * Pequeño store para acceder a negocios desde servicios.
 * Si después necesitamos más cosas (listar, guardar props, etc.)
 * las vamos agregando acá.
 */

const pool = require('../config/db');

/**
 * Devuelve el negocio por id o null si no existe.
 * Incluye las columnas completas de app_businesses, incl. props.
 */
async function getBusinessById(id) {
  const bizId = Number(id);
  if (!Number.isFinite(bizId)) {
    throw new Error(`getBusinessById: invalid id "${id}"`);
  }

  const { rows } = await pool.query(
    `
    SELECT *
    FROM app_businesses
    WHERE id = $1
    `,
    [bizId]
  );

  return rows[0] || null;
}

module.exports = {
  getBusinessById,
};