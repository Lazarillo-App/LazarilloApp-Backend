// services/hardDeleteUser.js
//
// Borra POR COMPLETO una cuenta de usuario: sus negocios (y todo lo que
// cuelga de ellos), sus asignaciones de equipo, su historial de auditoría, y
// finalmente la fila de app_users. ÚNICA fuente de verdad de este borrado —
// la usan tanto db/scripts/hard-delete-users.js (CLI, por email, para
// limpiezas en lote) como el botón "Borrar definitivo" del panel admin (por
// id, con confirmación en la UI). Rechaza borrar cuentas app_admin.
'use strict';

const pool = require('../config/db');

async function getBusinessScopedTables() {
  const { rows } = await pool.query(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.column_name = 'business_id' AND c.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name`
  );
  return rows.map((r) => r.table_name).filter((t) => t !== 'app_businesses');
}

async function deleteWithRetry(client, tables, bizIds) {
  let remaining = [...tables];
  for (let pass = 0; pass < 6 && remaining.length; pass++) {
    const stillRemaining = [];
    for (const t of remaining) {
      await client.query('SAVEPOINT sp');
      try {
        const { rowCount } = await client.query(
          `DELETE FROM "${t}" WHERE business_id = ANY($1)`, [bizIds]
        );
        await client.query('RELEASE SAVEPOINT sp');
        if (rowCount) console.log(`    ${t}: ${rowCount} fila(s) borrada(s)`);
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp');
        stillRemaining.push(t);
      }
    }
    remaining = stillRemaining;
  }
  if (remaining.length) {
    throw new Error(`No se pudo borrar (dependencias bloqueantes) en: ${remaining.join(', ')}`);
  }
}

/**
 * @param {object} opts
 * @param {number} [opts.userId] - por id (panel admin)
 * @param {string} [opts.email]  - por email (CLI), alternativa a userId
 * @returns {Promise<{ ok: true, deleted: { email, businesses: string[] } }>}
 */
async function hardDeleteUser({ userId = null, email = null } = {}) {
  if (!userId && !email) throw new Error('userId o email requerido');

  const { rows: userRows } = await pool.query(
    userId
      ? `SELECT id, email, role FROM app_users WHERE id = $1 LIMIT 1`
      : `SELECT id, email, role FROM app_users WHERE lower(email) = lower($1) LIMIT 1`,
    [userId || email]
  );
  const user = userRows[0];
  if (!user) { const e = new Error('NOT_FOUND'); e.code = 'NOT_FOUND'; throw e; }
  if (user.role === 'app_admin') {
    const e = new Error('No se puede borrar una cuenta app_admin por seguridad.');
    e.code = 'CANNOT_DELETE_ADMIN';
    throw e;
  }

  const { rows: bizRows } = await pool.query(
    `SELECT id, name FROM app_businesses WHERE owner_id = $1`, [user.id]
  );
  const bizIds = bizRows.map((b) => b.id);

  const businessTables = await getBusinessScopedTables();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (bizIds.length) {
      await deleteWithRetry(client, businessTables, bizIds);
      await client.query(
        `DELETE FROM user_assignments WHERE scope_type = 'business' AND scope_id = ANY($1)`,
        [bizIds]
      );
      await client.query(`DELETE FROM app_businesses WHERE id = ANY($1)`, [bizIds]);
    }

    await client.query(`DELETE FROM user_assignments WHERE user_id = $1`, [user.id]);
    await client.query(
      `DELETE FROM audit_log WHERE user_id = $1 OR (entity_type='app_user' AND entity_id = $2)`,
      [user.id, String(user.id)]
    );
    await client.query(`DELETE FROM account_activations WHERE user_id = $1`, [user.id]);
    await client.query(`DELETE FROM access_code_redemptions WHERE user_id = $1`, [user.id]);
    await client.query(`DELETE FROM app_users WHERE id = $1`, [user.id]);

    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    throw e;
  } finally {
    client.release();
  }

  return { ok: true, deleted: { email: user.email, businesses: bizRows.map((b) => b.name) } };
}

module.exports = { hardDeleteUser, getBusinessScopedTables, deleteWithRetry };
