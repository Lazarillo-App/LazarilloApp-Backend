// services/autoGroupingService.js
const pool = require('../config/db');

/**
 * Crea/actualiza agrupaciones a partir de la taxonomía normalizada.
 * strategy: 'by-categoria' | 'by-subrubro'
 */
async function materializeGroupsFromTaxonomy(businessId, { strategy = 'by-categoria' } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Traer pares (group_name, article_id) según estrategia
    const sqlBase = `
      SELECT
        ${strategy === 'by-subrubro' ? 's.nombre' : 'c.nombre'} AS group_name,
        a.id AS article_id
      FROM app_articles a
      JOIN categorias c ON c.id = a.categoria_id
      JOIN subrubros s ON s.id = a.subrubro_id
      WHERE a.business_id = $1
    `;
    const { rows: pairs } = await client.query(sqlBase, [businessId]);
    if (!pairs.length) { await client.query('COMMIT'); return { created: 0, linked: 0 }; }

    // 2) Asegurar agrupaciones (por nombre)
    const groupNames = Array.from(new Set(pairs.map(p => String(p.group_name || '').trim()).filter(Boolean)));

    // Lee existentes
    const { rows: existing } = await client.query(
      `SELECT id, nombre FROM agrupaciones WHERE business_id = $1 AND nombre = ANY($2::text[])`,
      [businessId, groupNames]
    );
    const idByName = new Map(existing.map(r => [r.nombre, r.id]));

    // Crea faltantes
    const toCreate = groupNames.filter(n => !idByName.has(n));
    if (toCreate.length) {
      const { rows: created } = await client.query(
        `
        INSERT INTO agrupaciones (business_id, nombre)
        SELECT $1::int, UNNEST($2::text[])
        RETURNING id, nombre
        `, [businessId, toCreate]
      );
      for (const r of created) idByName.set(r.nombre, r.id);
    }

    // 3) Vincular artículos a su agrupación (idempotente)
    //    Armamos arrays paralelos para un UNNEST masivo y hacemos ON CONFLICT DO NOTHING
    const agIds = [];
    const artIds = [];
    for (const { group_name, article_id } of pairs) {
      const gid = idByName.get(group_name);
      if (!gid) continue;
      agIds.push(gid);
      artIds.push(Number(article_id));
    }

    let linked = 0;
    if (agIds.length) {
      const res = await client.query(
        `
        INSERT INTO agrupacion_articulos (agrupacion_id, articulo_id)
        SELECT * FROM UNNEST($1::int[], $2::int[])
        ON CONFLICT DO NOTHING
        `,
        [agIds, artIds]
      );
      linked = res.rowCount || 0;
    }

    await client.query('COMMIT');
    return { created: toCreate.length, linked };
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally {
    client.release();
  }
}

module.exports = { materializeGroupsFromTaxonomy };
