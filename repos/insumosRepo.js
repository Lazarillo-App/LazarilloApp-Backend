// repos/insumosRubrosRepo.js
'use strict';

const pool = require('../config/db');

/**
 * upsertRubrosForBusiness(businessId, items)
 * items: [{ codigo, nombre, cptoCaja }]
 */
async function upsertRubrosForBusiness(businessId, items = []) {
  if (!businessId) throw new Error('businessId requerido en upsertRubrosForBusiness');

  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;

  try {
    await client.query('BEGIN');

    for (const it of items) {
      const { codigo, nombre, cptoCaja } = it;
      if (!codigo) continue;

      const r = await client.query(
        `INSERT INTO insumo_rubros
           (business_id, codigo, nombre, cpto_caja)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (business_id, codigo) DO UPDATE SET
           nombre     = EXCLUDED.nombre,
           cpto_caja  = EXCLUDED.cpto_caja,
           updated_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [businessId, codigo, nombre, cptoCaja]
      );

      if (r.rows?.[0]?.inserted) inserted++;
      else updated++;
    }

    await client.query('COMMIT');
    return { inserted, updated, total: inserted + updated };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('upsertRubrosForBusiness error:', e);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * listRubrosForBusiness(businessId)
 */
async function listRubrosForBusiness(businessId) {
  if (!businessId) throw new Error('businessId requerido en listRubrosForBusiness');

  const { rows } = await pool.query(
    `SELECT id, business_id, codigo, nombre, cpto_caja, created_at, updated_at
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
