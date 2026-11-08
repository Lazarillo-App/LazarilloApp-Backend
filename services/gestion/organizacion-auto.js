// services/gestion/organizacion-auto.js
//
// El Panel de gestión necesita que el negocio pertenezca a una organización
// (los maestros de conceptos, rubros y proveedores son de la organización).
// Un negocio nuevo del asistente de alta nacía sin organización y el Panel
// respondía 409 a todo ("Error al cargar los datos", Diego 08/11). Acá se le
// crea una organización propia con el nombre del negocio, una sola vez.
'use strict';

const pool = require('../../config/db');

/**
 * Devuelve el organization_id del negocio; si no tiene, crea una organización
 * con su nombre y lo vincula. Idempotente y a prueba de dos pedidos a la vez.
 */
async function asegurarOrganizacion(businessId, userId = null) {
  const bizId = Number(businessId);
  if (!Number.isFinite(bizId) || bizId <= 0) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, name, organization_id FROM app_businesses WHERE id = $1 FOR UPDATE', [bizId]);
    if (!rows[0]) { await client.query('ROLLBACK'); return null; }
    if (rows[0].organization_id) { await client.query('COMMIT'); return Number(rows[0].organization_id); }
    const nombre = String(rows[0].name || 'Mi negocio').trim() || 'Mi negocio';
    const { rows: org } = await client.query(
      `INSERT INTO organizations (name, display_name, created_by, created_at, updated_at)
       VALUES ($1, $1, $2, NOW(), NOW()) RETURNING id`, [nombre, userId || null]);
    await client.query('UPDATE app_businesses SET organization_id = $1 WHERE id = $2', [org[0].id, bizId]);
    await client.query('COMMIT');
    console.log(`[organizacion-auto] negocio ${bizId} → organización ${org[0].id} "${nombre}"`);
    return Number(org[0].id);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[organizacion-auto] error:', e?.message || e);
    return null;
  } finally {
    client.release();
  }
}

module.exports = { asegurarOrganizacion };
