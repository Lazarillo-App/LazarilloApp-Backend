// db/scripts/delete-business-and-owner-data.js
//
// Borra por completo el/los negocio(s) de un usuario y todos los datos
// relacionados a ese negocio — pensado para limpiar una cuenta de prueba que
// se va a reconvertir en algo distinto (ej. una cuenta app_admin), sin dejar
// negocios huérfanos con datos colgando.
//
// NO toca la fila de app_users (el usuario en sí no se borra ni se le cambia
// el rol) — solo el/los negocio(s) que posee y todo lo que cuelga de ellos.
//
// Descubre las tablas a limpiar consultando el esquema REAL de la base
// (information_schema), no una lista fija — porque este repo no versiona
// todos los cambios de esquema en migraciones (hay columnas/tablas agregadas
// a mano en producción que no están en el código).
//
// Uso:
//   node db/scripts/delete-business-and-owner-data.js --email=alguien@ejemplo.com
//     → SOLO reporta qué se borraría (dry-run, default).
//   node db/scripts/delete-business-and-owner-data.js --email=alguien@ejemplo.com --confirm
//     → borra de verdad, todo en una sola transacción (o todo o nada).

require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const emailArg = process.argv.find((a) => a.startsWith('--email='));
  const confirm = process.argv.includes('--confirm');
  if (!emailArg) {
    throw new Error('Uso: node db/scripts/delete-business-and-owner-data.js --email=alguien@ejemplo.com [--confirm]');
  }
  const email = emailArg.split('=')[1].trim().toLowerCase();

  const { rows: userRows } = await pool.query(
    `SELECT id, email, role, name FROM app_users WHERE lower(email) = $1 LIMIT 1`,
    [email]
  );
  if (!userRows.length) throw new Error(`No existe ningún usuario con el email ${email}.`);
  const user = userRows[0];
  console.log('Usuario:', user);

  const { rows: bizRows } = await pool.query(
    `SELECT id, name FROM app_businesses WHERE owner_id = $1`,
    [user.id]
  );
  if (!bizRows.length) {
    console.log('Este usuario no es dueño de ningún negocio. Nada para borrar.');
    await pool.end();
    return;
  }
  console.log(`\nNegocio(s) a borrar (${bizRows.length}):`);
  bizRows.forEach((b) => console.log(`  - [${b.id}] ${b.name}`));
  const bizIds = bizRows.map((b) => b.id);

  // Tablas reales (no solo las trackeadas en migraciones) con columna business_id.
  const { rows: tableRows } = await pool.query(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name = 'business_id' AND table_schema = 'public'
      ORDER BY table_name`
  );
  const tables = tableRows.map((r) => r.table_name).filter((t) => t !== 'app_businesses');

  console.log('\nFilas afectadas por tabla:');
  const counts = {};
  for (const t of tables) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM "${t}" WHERE business_id = ANY($1)`,
      [bizIds]
    );
    counts[t] = rows[0].n;
    if (rows[0].n > 0) console.log(`  ${t}: ${rows[0].n}`);
  }

  const { rows: uaCount } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM user_assignments WHERE scope_type = 'business' AND scope_id = ANY($1)`,
    [bizIds]
  );
  console.log(`  user_assignments (scope_type=business): ${uaCount[0].n}`);

  if (!confirm) {
    console.log('\n[dry-run] No se borró nada. Corré de nuevo agregando --confirm para borrar de verdad.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Varias pasadas con SAVEPOINT por tabla: si una tabla falla por una FK
    // que depende de otra que todavía no se borró, se reintenta en la
    // siguiente pasada, sin necesidad de conocer de antemano el orden exacto
    // de dependencias entre tablas.
    let remaining = [...tables];
    for (let pass = 0; pass < 6 && remaining.length; pass++) {
      const stillRemaining = [];
      for (const t of remaining) {
        if (!counts[t]) continue; // nada que borrar en esta tabla
        await client.query('SAVEPOINT sp');
        try {
          await client.query(`DELETE FROM "${t}" WHERE business_id = ANY($1)`, [bizIds]);
          await client.query('RELEASE SAVEPOINT sp');
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT sp');
          stillRemaining.push(t);
        }
      }
      remaining = stillRemaining;
    }
    if (remaining.length) {
      await client.query('ROLLBACK');
      throw new Error(`No se pudo borrar (dependencias bloqueantes) en: ${remaining.join(', ')}. No se borró nada.`);
    }

    await client.query(
      `DELETE FROM user_assignments WHERE scope_type = 'business' AND scope_id = ANY($1)`,
      [bizIds]
    );
    await client.query(`DELETE FROM app_businesses WHERE id = ANY($1)`, [bizIds]);

    await client.query('COMMIT');
    console.log('\nListo: negocio(s) y datos relacionados eliminados. La cuenta de usuario no se tocó.');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('delete-business-and-owner-data error:', e.message);
  process.exit(1);
});
