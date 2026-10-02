// db/scripts/hard-delete-users.js
//
// Borra POR COMPLETO una o más cuentas de usuario: sus negocios (y todo lo
// que cuelga de ellos), sus asignaciones de equipo, su historial de
// auditoría, y finalmente la fila de app_users. Pensado para limpiar cuentas
// de test. La lógica real vive en services/hardDeleteUser.js — la comparte
// con el botón "Borrar definitivo" del panel admin, para no tener dos copias
// de un borrado en cascada que puedan divergir.
//
// Rechaza borrar cuentas app_admin (mismo criterio que el panel).
//
// Uso:
//   EMAILS="test1@x.com,test2@y.com" node db/scripts/hard-delete-users.js
//     → SOLO reporta qué se borraría (dry-run, default).
//   EMAILS="test1@x.com,test2@y.com" node db/scripts/hard-delete-users.js --confirm
//     → borra de verdad. Cada email se procesa por separado: si uno falla,
//       no afecta a los demás.

require('dotenv').config();
const pool = require('../../config/db');
const { hardDeleteUser } = require('../../services/hardDeleteUser');

async function processOne(email, confirm) {
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
  console.log(`  user_assignments propias: ${uaCount[0].n}`);
  console.log(`  audit_log: ${auditCount[0].n}`);

  if (!confirm) return;

  try {
    const result = await hardDeleteUser({ userId: user.id });
    console.log(`  Borrado por completo. Negocios borrados: ${result.deleted.businesses.join(', ') || '(ninguno)'}`);
  } catch (e) {
    console.error(`  FALLÓ, no se borró nada de este usuario: ${e.message}`);
  }
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const emails = (process.env.EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) throw new Error('Definí EMAILS="a@x.com,b@y.com" como env var.');

  for (const email of emails) {
    await processOne(email, confirm);
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
