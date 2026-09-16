// db/scripts/hard-delete-users.js
//
// Borra POR COMPLETO una o más cuentas de usuario: sus negocios (y todo lo
// que cuelga de ellos, igual que delete-business-and-owner-data.js), sus
// asignaciones de equipo, su historial de auditoría, y finalmente la fila de
// app_users. Pensado para limpiar cuentas de test, NUNCA para usuarios reales
// — no expuesto en el panel a propósito, es deliberadamente más trabajoso de
// correr que el botón "Eliminar" (que es soft-delete y reversible).
//
// Rechaza borrar cuentas app_admin (mismo criterio que el panel).
//
// Uso:
//   EMAILS="test1@x.com,test2@y.com" node db/scripts/hard-delete-users.js
//     → SOLO reporta qué se borraría (dry-run, default).
//   EMAILS="test1@x.com,test2@y.com" node db/scripts/hard-delete-users.js --confirm
//     → borra de verdad. Cada email se procesa en su propia transacción: si
//       uno falla, no afecta a los demás.

require('dotenv').config();
const pool = require('../../config/db');

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

async function processOne(email, confirm, businessTables) {
  console.log(`\n=== ${email} ===`);
  const { rows: userRows } = await pool.query(
    `SELECT id, email, role FROM app_users WHERE lower(email) = $1 LIMIT 1`,
    [email]
  );
  if (!userRows.length) {
    console.log('  No existe ningún usuario con ese email. Se omite.');
    return;
  }
  const user = userRows[0];
  if (user.role === 'app_admin') {
    console.log('  Es una cuenta app_admin — no se borra por seguridad. Se omite.');
    return;
  }

  const { rows: bizRows } = await pool.query(
    `SELECT id, name FROM app_businesses WHERE owner_id = $1`, [user.id]
  );
  const bizIds = bizRows.map((b) => b.id);
  if (bizRows.length) {
    console.log(`  Negocios propios (${bizRows.length}): ${bizRows.map((b) => b.name).join(', ')}`);
  }

  const { rows: uaCount } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM user_assignments WHERE user_id = $1`, [user.id]
  );
  const { rows: auditCount } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM audit_log WHERE user_id = $1 OR (entity_type='app_user' AND entity_id = $2)`,
    [user.id, String(user.id)]
  );
  const { rows: actCount } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM account_activations WHERE user_id = $1`, [user.id]
  );
  console.log(`  user_assignments propias: ${uaCount[0].n}`);
  console.log(`  audit_log: ${auditCount[0].n}`);
  console.log(`  account_activations: ${actCount[0].n}`);

  if (!confirm) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (bizIds.length) {
      console.log('  Borrando datos de sus negocios...');
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
    await client.query(`DELETE FROM app_users WHERE id = $1`, [user.id]);

    await client.query('COMMIT');
    console.log(`  Borrado por completo.`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(`  FALLÓ, no se borró nada de este usuario: ${e.message}`);
  } finally {
    client.release();
  }
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const emails = (process.env.EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) throw new Error('Definí EMAILS="a@x.com,b@y.com" como env var.');

  const businessTables = await getBusinessScopedTables();

  for (const email of emails) {
    await processOne(email, confirm, businessTables);
  }

  if (!confirm) {
    console.log('\n[dry-run] No se borró nada. Corré de nuevo agregando --confirm para borrar de verdad.');
  }
  await pool.end();
}

main().catch((e) => {
  console.error('hard-delete-users error:', e.message);
  process.exit(1);
});
