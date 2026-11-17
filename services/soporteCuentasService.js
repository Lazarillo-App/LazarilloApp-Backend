// services/soporteCuentasService.js
//
// Soporte Lazarillo por cuenta (tablero #103, 17/11/2026). Con organizations.soporte_activo los super
// usuarios entran a los negocios de esa cuenta como dueños (ver services/auth/accessControl.js y la
// migración 141). Acá se lista y se prende/apaga desde el panel super: al soltar, los super usuarios
// dejan de ver la cuenta. Cada cambio queda en la Actividad de admins y avisa en la campanita de
// cada negocio de la cuenta, para que el dueño sepa quién tiene acceso.
'use strict';

const pool = require('../config/db');
const actividad = require('./superActividadService');
const { avisarAlEquipo } = require('./notificationService');

/** Cuentas (organizaciones) con sus negocios, el dueño y si tienen soporte activo. */
async function listar() {
  const { rows } = await pool.query(`
    SELECT o.id, o.name, o.soporte_activo, o.created_at,
           json_agg(json_build_object('id', b.id, 'name', b.name) ORDER BY b.created_at) AS negocios,
           (SELECT coalesce(u.display_name, u.name, u.email) FROM app_users u
             WHERE u.id = (SELECT b2.owner_id FROM app_businesses b2 WHERE b2.organization_id = o.id ORDER BY b2.created_at LIMIT 1)) AS duenio
      FROM organizations o
      JOIN app_businesses b ON b.organization_id = o.id
     GROUP BY o.id
     ORDER BY o.soporte_activo DESC, lower(o.name)`);
  return { cuentas: rows };
}

/** Prende o apaga el soporte de una cuenta. */
async function cambiar(orgId, activo, userId) {
  const id = Number(orgId);
  if (!Number.isInteger(id) || id <= 0) return { error: 'cuenta_invalida' };
  if (typeof activo !== 'boolean') return { error: 'activo_invalido' };
  const { rows } = await pool.query(
    `UPDATE organizations SET soporte_activo = $2, updated_at = now() WHERE id = $1 AND soporte_activo IS DISTINCT FROM $2
     RETURNING id, name, soporte_activo`, [id, activo]);
  if (!rows[0]) {
    const { rows: hay } = await pool.query('SELECT id, name, soporte_activo FROM organizations WHERE id = $1', [id]);
    return hay[0] ? { cuenta: hay[0], sinCambios: true } : { error: 'no_encontrada', status: 404 };
  }
  const cuenta = rows[0];
  await actividad.registrar(userId, 'soporte', activo ? 'activó el soporte de' : 'soltó la cuenta', { titulo: cuenta.name });

  const { rows: negocios } = await pool.query('SELECT id FROM app_businesses WHERE organization_id = $1', [id]);
  const title = activo ? 'Soporte Lazarillo activado' : 'Soporte Lazarillo desactivado';
  const message = activo
    ? 'El equipo de Lazarillo puede entrar a tu cuenta para ayudarte, sin sumarse a tu equipo.'
    : 'El equipo de Lazarillo ya no tiene acceso a tu cuenta. Si necesitás ayuda, escribinos desde Anthony.';
  for (const n of negocios) {
    await avisarAlEquipo({ businessId: n.id, type: 'soporte_lazarillo', title, message, metadata: { organization_id: id, activo } })
      .catch((e) => console.error('[soporteCuentas] aviso', n.id, e.message));
  }
  return { cuenta };
}

module.exports = { listar, cambiar };
