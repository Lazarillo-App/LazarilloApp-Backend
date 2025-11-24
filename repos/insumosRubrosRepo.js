// repos/insumosRubrosRepo.js
'use strict';

const pool = require('../config/db');

async function upsertRubrosForBusiness(businessId, items = []) {
  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  try {
    await client.query('BEGIN');

    for (const it of items) {
      const codigo = Number(it.codigo);
      if (!Number.isFinite(codigo)) { skipped++; continue; }

      const nombre = (it.nombre ?? '').trim();
      const cptoCaja = it.cptoCaja != null ? Number(it.cptoCaja) : null;

      const r = await client.query(
        `INSERT INTO insumo_rubros (business_id, codigo_maxi, nombre, cpto_caja, activo)
         VALUES ($1,$2,$3,$4,TRUE)
         ON CONFLICT (business_id, codigo_maxi) DO UPDATE SET
           nombre     = EXCLUDED.nombre,
           cpto_caja  = EXCLUDED.cpto_caja,
           activo     = TRUE,
           updated_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [businessId, codigo, nombre, cptoCaja]
      );

      if (r.rows?.[0]?.inserted) inserted++;
      else updated++;
    }

    await client.query('COMMIT');
    return { inserted, updated, skipped, total: inserted + updated + skipped };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('upsertRubrosForBusiness error:', e);
    throw e;
  } finally {
    client.release();
  }
}

async function listRubrosForBusiness(businessId) {
  const { rows } = await pool.query(
    `SELECT *
       FROM insumo_rubros
      WHERE business_id = $1
        AND activo = TRUE
      ORDER BY nombre ASC`,
    [businessId]
  );
  return rows;
}

module.exports = {
  upsertRubrosForBusiness,
  listRubrosForBusiness,
};
