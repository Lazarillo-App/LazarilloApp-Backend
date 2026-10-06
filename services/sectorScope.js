// services/sectorScope.js
// Qué artículos puede ver un miembro del staff según los sectores que tiene asignados.
// Devuelve null cuando NO hay restricción (owner/admin, sector "Todos" o sin sector):
// en ese caso el llamador no filtra nada.
const pool = require('../config/db');
const { getEffectiveRole } = require('./auth/accessControl');

async function articleIdsPermitidos(userId, businessId, storageBizId) {
  if (!userId || !businessId) return null;
  const role = await getEffectiveRole(userId, businessId);
  if (role !== 'staff') return null;

  const { rows: asig } = await pool.query(
    `SELECT COALESCE(sector_ids, '{}'::int[]) AS sector_ids
       FROM user_assignments
      WHERE user_id = $1 AND scope_type = 'business' AND scope_id = $2 AND revoked_at IS NULL
      LIMIT 1`,
    [userId, businessId]
  );
  const sectorIds = (asig[0]?.sector_ids || []).map(Number).filter(Number.isFinite);
  if (!sectorIds.length) return null;

  const { rows: sectores } = await pool.query(
    `SELECT id, es_fijo FROM sectores WHERE id = ANY($1::int[])`,
    [sectorIds]
  );
  if (sectores.some((s) => s.es_fijo)) return null;

  const { rows: items } = await pool.query(
    `SELECT tipo, agrupacion_id, rubro, subrubro, articulo_id
       FROM sector_scope_items WHERE sector_id = ANY($1::int[])`,
    [sectorIds]
  );

  const permitidos = new Set();
  const agIds = [...new Set(items.filter((i) => i.tipo === 'agrupacion' && i.agrupacion_id).map((i) => Number(i.agrupacion_id)))];
  if (agIds.length) {
    const { rows: ags } = await pool.query(
      `SELECT articulos, app_articles_ids FROM agrupaciones WHERE id = ANY($1::bigint[])`,
      [agIds]
    );
    for (const ag of ags) {
      const arts = Array.isArray(ag.articulos) ? ag.articulos : JSON.parse(ag.articulos || '[]');
      for (const a of arts) { const id = Number(a?.id ?? a?.articulo_id ?? a); if (Number.isFinite(id) && id !== 0) permitidos.add(id); }
      for (const id of ag.app_articles_ids || []) { const n = Number(id); if (Number.isFinite(n) && n !== 0) permitidos.add(n); }
    }
  }

  const porRubro = items.filter((i) => i.tipo === 'rubro' || i.tipo === 'subrubro');
  for (const i of items.filter((x) => x.tipo === 'articulo' && x.articulo_id)) permitidos.add(Number(i.articulo_id));

  if (porRubro.length) {
    // Convención de la carta/árbol: "rubro" de la UI = maxi_articles.subrubro; "subrubro" de la UI = maxi_articles.categoria
    const { rows: arts } = await pool.query(
      `SELECT articulo_id, subrubro, categoria FROM maxi_articles WHERE business_id = $1 AND is_active = true`,
      [storageBizId]
    );
    for (const a of arts) {
      const ok = porRubro.some((i) =>
        i.tipo === 'rubro'
          ? i.rubro === a.subrubro
          : i.rubro === a.subrubro && i.subrubro === a.categoria
      );
      if (ok) permitidos.add(Number(a.articulo_id));
    }
  }
  return permitidos;
}

module.exports = { articleIdsPermitidos };
