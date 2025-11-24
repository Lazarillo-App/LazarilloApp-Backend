// repos/insumosRubrosRepo.js
'use strict';

const pool = require('../config/db');

/**
 * Inserta / actualiza rubros de insumos para un negocio.
 * Usa la UNIQUE (business_id, codigo).
 */
async function upsertRubrosForBusiness(businessId, items = []) {
  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  try {
    await client.query('BEGIN');

    for (const it of items) {
      const codigo = Number(it.codigo);
      if (!Number.isFinite(codigo)) {
        skipped++;
        continue;
      }

      const nombre = (it.nombre || '').trim();
      const cptoCaja = it.cpto_caja != null ? Number(it.cpto_caja) : null;
      const esElaborador = !!it.es_elaborador;
      const activo = it.activo !== false;

      const r = await client.query(
        `INSERT INTO insumo_rubros
          (business_id, codigo, codigo_maxi, nombre, cpto_caja, es_elaborador, activo)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (business_id, codigo) DO UPDATE SET
           codigo_maxi   = EXCLUDED.codigo_maxi,
           nombre        = EXCLUDED.nombre,
           cpto_caja     = EXCLUDED.cpto_caja,
           es_elaborador = EXCLUDED.es_elaborador,
           activo        = EXCLUDED.activo,
           updated_at    = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [
          businessId,
          codigo,
          codigo, // lo guardamos también en codigo_maxi por comodidad
          nombre,
          cptoCaja,
          esElaborador,
          activo,
        ]
      );

      if (r.rows?.[0]?.inserted) inserted++;
      else updated++;
    }

    await client.query('COMMIT');
    return { inserted, updated, skipped, total: inserted + updated + skipped };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('upsertRubrosForBusiness error:', err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lista rubros de insumos para un negocio.
 */
async function listRubrosForBusiness(businessId) {
  const { rows } = await pool.query(
    `SELECT *
       FROM insumo_rubros
      WHERE business_id = $1
      ORDER BY nombre ASC`,
    [businessId]
  );
  return rows;
}

module.exports = {
  upsertRubrosForBusiness,
  listRubrosForBusiness,
};
