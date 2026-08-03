// repos/dashboardStoreRepo.js
// Acceso a la tabla dashboard_store. Todo scopeado por business_id.
const pool = require('../config/db');

/** get: devuelve el value (string) o null si no existe. */
async function get(businessId, key) {
  const { rows } = await pool.query(
    `SELECT value FROM dashboard_store WHERE business_id = $1 AND store_key = $2 LIMIT 1`,
    [businessId, key]
  );
  return rows[0] ? rows[0].value : null;
}

/** set: upsert. Devuelve true. */
async function set(businessId, key, value) {
  await pool.query(
    `INSERT INTO dashboard_store (business_id, store_key, value, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (business_id, store_key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [businessId, key, value]
  );
  return true;
}

/** del: borra una key. Devuelve la cantidad de filas borradas (0 o 1). */
async function del(businessId, key) {
  const { rowCount } = await pool.query(
    `DELETE FROM dashboard_store WHERE business_id = $1 AND store_key = $2`,
    [businessId, key]
  );
  return rowCount;
}

/** list: devuelve las keys que empiezan con `prefix` (o todas si prefix vacío). */
async function list(businessId, prefix) {
  const p = (prefix || '').replace(/[%_\\]/g, (m) => '\\' + m); // escapar comodines LIKE
  const { rows } = await pool.query(
    `SELECT store_key FROM dashboard_store
     WHERE business_id = $1 AND store_key LIKE $2 ESCAPE '\\'
     ORDER BY store_key`,
    [businessId, p + '%']
  );
  return rows.map((r) => r.store_key);
}

module.exports = { get, set, del, list };
