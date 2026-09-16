// db/scripts/reassign-owner-by-email.js
//
// Transfiere TODOS los negocios (y las asignaciones de equipo asociadas) de
// un usuario a otro, identificados por email. No borra nada — los negocios y
// todos sus datos quedan intactos, solo cambia quién figura como dueño.
// Pensado para separar "cuenta admin" de "cuenta de testing" sin perder el
// trabajo de prueba acumulado.
//
// Si el email de destino no existe todavía, lo crea (necesita TO_PASS).
// Si ya existe, lo reusa tal cual (no le toca la contraseña).
//
// Uso (variables de entorno, no como argumentos, para no dejarlas en el
// historial de la shell):
//   FROM_EMAIL=mairenevillasmilf@gmail.com \
//   TO_EMAIL=mairenevillasmil@gmail.com \
//   TO_NAME="Mairene (testing)" \
//   TO_PASS="una-contraseña-segura" \
//     node db/scripts/reassign-owner-by-email.js

require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../../config/db');

async function main() {
  const fromEmail = (process.env.FROM_EMAIL || '').trim().toLowerCase();
  const toEmail = (process.env.TO_EMAIL || '').trim().toLowerCase();
  const toName = process.env.TO_NAME || 'Testing';
  const toPass = process.env.TO_PASS;

  if (!fromEmail || !toEmail) {
    throw new Error('Definí FROM_EMAIL y TO_EMAIL como env vars.');
  }
  if (fromEmail === toEmail) {
    throw new Error('FROM_EMAIL y TO_EMAIL no pueden ser el mismo email.');
  }

  const { rows: fromRows } = await pool.query(
    `SELECT id, email FROM app_users WHERE lower(email) = $1 LIMIT 1`, [fromEmail]
  );
  if (!fromRows.length) throw new Error(`No existe ningún usuario con FROM_EMAIL (${fromEmail}).`);
  const fromUser = fromRows[0];

  let { rows: toRows } = await pool.query(
    `SELECT id, email FROM app_users WHERE lower(email) = $1 LIMIT 1`, [toEmail]
  );
  let toUser = toRows[0];

  if (!toUser) {
    if (!toPass) throw new Error('TO_EMAIL no existe todavía — definí TO_PASS para crearlo.');
    if (toPass.length < 6) throw new Error('TO_PASS debe tener al menos 6 caracteres.');
    const hash = await bcrypt.hash(toPass, 10);
    const { rows: created } = await pool.query(
      `INSERT INTO app_users (name, email, password_hash, role, status, account_status)
       VALUES ($1, $2, $3, 'owner', 'active', 'active')
       RETURNING id, email`,
      [toName, toEmail, hash]
    );
    toUser = created[0];
    console.log('Cuenta de destino creada:', toUser);
  } else {
    console.log('Cuenta de destino ya existía, se reusa tal cual:', toUser);
  }

  const { rows: bizRows } = await pool.query(
    `SELECT id, name FROM app_businesses WHERE owner_id = $1`, [fromUser.id]
  );
  if (!bizRows.length) {
    console.log(`${fromEmail} no es dueño de ningún negocio. Nada para transferir.`);
    await pool.end();
    return;
  }
  console.log(`\nNegocios a transferir (${bizRows.length}):`);
  bizRows.forEach((b) => console.log(`  - [${b.id}] ${b.name}`));
  const bizIds = bizRows.map((b) => b.id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE app_businesses SET owner_id = $1 WHERE id = ANY($2)`,
      [toUser.id, bizIds]
    );

    const { rowCount } = await client.query(
      `UPDATE user_assignments SET user_id = $1, updated_at = NOW()
        WHERE scope_type = 'business' AND scope_id = ANY($2) AND user_id = $3`,
      [toUser.id, bizIds, fromUser.id]
    );

    await client.query('COMMIT');
    console.log(`\nListo: ${bizRows.length} negocio(s) reasignado(s) a ${toEmail}.`);
    console.log(`Asignaciones de equipo transferidas: ${rowCount}.`);
    console.log(`${fromEmail} ya no es dueño de ningún negocio.`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('reassign-owner-by-email error:', e.message);
  process.exit(1);
});
