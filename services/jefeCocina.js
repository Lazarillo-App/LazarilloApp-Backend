// services/jefeCocina.js
// Jefe de cocina (Diego 11/11/2026): subrol de Staff (user_assignments.subrol = 'jefe').
// Conduce los sectores de su sector_ids: da el OK a los cambios de su equipo antes de que
// lleguen al admin. Sin jefe en el sector, el circuito de aprobación no cambia.
'use strict';

const pool = require('../config/db');
const { sqlEsJefe } = require('./auth/permisos');

const SUBROLES = ['jefe'];

// Sectores que conduce uid en el negocio ([] si no es jefe).
async function sectoresQueConduce(uid, bizId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(ua.sector_ids, '{}'::int[]) AS sector_ids
       FROM user_assignments ua
      WHERE ua.user_id = $1 AND ua.scope_type = 'business' AND ua.scope_id = $2
        AND ua.revoked_at IS NULL AND ${sqlEsJefe('ua')}
      LIMIT 1`,
    [uid, bizId]
  );
  return (rows[0]?.sector_ids || []).map(Number).filter(Number.isFinite);
}

// Jefes (user_id) del sector en el negocio.
async function jefesDelSector(bizId, sectorId) {
  if (!sectorId) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ua.user_id FROM user_assignments ua
      WHERE ua.scope_type = 'business' AND ua.scope_id = $1 AND ${sqlEsJefe('ua')}
        AND ua.revoked_at IS NULL AND ua.sector_ids @> ARRAY[$2::int]`,
    [bizId, sectorId]
  );
  return rows.map((r) => Number(r.user_id));
}

// SQL (sobre el alias p de receta_proposals): la propuesta espera el OK de un jefe.
// Hay jefe en su sector, el jefe todavía no la aprobó y no la hizo un jefe de ese sector.
const SQL_ESPERA_JEFE = `(
  p.jefe_ok_at IS NULL AND p.sector_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM user_assignments j
               WHERE j.scope_type = 'business' AND j.scope_id = p.business_id AND ${sqlEsJefe('j')}
                 AND j.revoked_at IS NULL AND j.sector_ids @> ARRAY[p.sector_id::int])
  AND NOT EXISTS (SELECT 1 FROM user_assignments j2
               WHERE j2.scope_type = 'business' AND j2.scope_id = p.business_id AND j2.user_id = p.created_by_user_id
                 AND ${sqlEsJefe('j2')} AND j2.revoked_at IS NULL
                 AND j2.sector_ids @> ARRAY[p.sector_id::int])
)`;

// ¿uid puede decidir como jefe sobre esta propuesta? (su sector, sin OK todavía, no es propia)
async function puedeDecidirComoJefe(uid, bizId, proposal) {
  if (!proposal || proposal.jefe_ok_at || !proposal.sector_id) return false;
  if (Number(proposal.created_by_user_id) === Number(uid)) return false;
  const sectores = await sectoresQueConduce(uid, bizId);
  return sectores.includes(Number(proposal.sector_id));
}

module.exports = { SUBROLES, sectoresQueConduce, jefesDelSector, SQL_ESPERA_JEFE, puedeDecidirComoJefe };
