// services/hardDeleteUser.js
//
// Borra POR COMPLETO una cuenta de usuario: sus negocios (y todo lo que
// cuelga de ellos), sus asignaciones de equipo, su historial de auditoría, y
// finalmente la fila de app_users. ÚNICA fuente de verdad de este borrado —
// la usan tanto db/scripts/hard-delete-users.js (CLI, por email, para
// limpiezas en lote) como el botón "Borrar definitivo" del panel admin (por
// id, con confirmación en la UI). Rechaza borrar cuentas app_admin.
//
// Las referencias se leen del catálogo de la base (pg_constraint), no de una
// lista fija: así las tablas nuevas (Panel de Gestión, propuestas de receta,
// accesos por sucursal…) no vuelven a frenar el borrado. Antes solo se
// limpiaban las columnas llamadas `business_id` y fallaba con, por ejemplo,
// `origen_business_id` o con otro usuario que tenía el negocio como activo.
'use strict';

const pool = require('../config/db');

async function getBusinessScopedTables(db = pool) {
  const { rows } = await db.query(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.column_name = 'business_id' AND c.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name`
  );
  return rows.map((r) => r.table_name).filter((t) => t !== 'app_businesses');
}

// FKs de una sola columna dentro de `public`, agrupadas por tabla padre.
async function mapaDeReferencias(db) {
  const { rows } = await db.query(
    `SELECT ch.relname AS hijo, a.attname AS col, p.relname AS padre,
            pa.attname AS refcol, con.confdeltype::text AS al_borrar,
            a.attnotnull AS obligatoria
       FROM pg_constraint con
       JOIN pg_class ch ON ch.oid = con.conrelid
       JOIN pg_namespace nch ON nch.oid = ch.relnamespace
       JOIN pg_class p ON p.oid = con.confrelid
       JOIN pg_namespace np ON np.oid = p.relnamespace
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
       JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
      WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
        AND nch.nspname = 'public' AND np.nspname = 'public'`
  );
  const mapa = new Map();
  for (const r of rows) {
    if (!mapa.has(r.padre)) mapa.set(r.padre, []);
    mapa.get(r.padre).push(r);
  }
  return mapa;
}

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

// Borra las filas de `tabla` que cumplen `where` (que usa $1), limpiando antes
// las filas hijas que las referencian sin ON DELETE CASCADE / SET NULL: un
// cascade a mano. Nunca borra usuarios: una columna de app_users que apunta a
// lo que se borra (ej. active_business_id) se pone en NULL.
async function borrarEnCascada(client, mapa, tabla, where, param, camino = []) {
  if (camino.length > 8) throw new Error(`Cadena de referencias demasiado larga: ${camino.join(' → ')}`);
  for (const ref of mapa.get(tabla) || []) {
    if (ref.al_borrar === 'n' || ref.al_borrar === 'd') continue; // la base ya lo resuelve
    if (ref.hijo === tabla || camino.includes(ref.hijo)) continue; // autorreferencia o ciclo
    const sub = `${q(ref.col)} IN (SELECT ${q(ref.refcol)} FROM ${q(tabla)} WHERE ${where})`;
    if (ref.hijo === 'app_users') {
      if (ref.obligatoria) throw new Error(`app_users.${ref.col} apunta a ${tabla} y no admite vacío`);
      await client.query(`UPDATE app_users SET ${q(ref.col)} = NULL WHERE ${sub}`, [param]);
      continue;
    }
    await borrarEnCascada(client, mapa, ref.hijo, sub, param, [...camino, tabla]);
  }
  await client.query(`DELETE FROM ${q(tabla)} WHERE ${where}`, [param]);
}

// Se mantiene por compatibilidad con quien lo importe; ahora usa el cascade.
async function deleteWithRetry(client, tables, bizIds) {
  const mapa = await mapaDeReferencias(client);
  for (const t of tables) {
    await borrarEnCascada(client, mapa, t, 'business_id = ANY($1)', bizIds);
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mapa = await mapaDeReferencias(client);

    if (bizIds.length) {
      // Tablas con business_id aunque no tengan FK declarada.
      for (const t of await getBusinessScopedTables(client)) {
        await borrarEnCascada(client, mapa, t, 'business_id = ANY($1)', bizIds);
      }
      await client.query(
        `DELETE FROM user_assignments WHERE scope_type = 'business' AND scope_id = ANY($1)`,
        [bizIds]
      );
      await borrarEnCascada(client, mapa, 'app_businesses', 'id = ANY($1)', bizIds);
    }

    await client.query(`DELETE FROM user_assignments WHERE user_id = $1`, [user.id]);
    await client.query(
      `DELETE FROM audit_log WHERE user_id = $1 OR (entity_type='app_user' AND entity_id = $2)`,
      [user.id, String(user.id)]
    );
    await client.query(`DELETE FROM account_activations WHERE user_id = $1`, [user.id]);
    await client.query(`DELETE FROM access_code_redemptions WHERE user_id = $1`, [user.id]);

    // Lo que quedó apuntando al usuario fuera de sus negocios: si la columna
    // admite vacío (creado por, decidido por…) se pone en NULL y el registro
    // queda; si no, se borra el registro.
    for (const ref of mapa.get('app_users') || []) {
      if (ref.al_borrar === 'n' || ref.al_borrar === 'd' || ref.hijo === 'app_users') continue;
      if (!ref.obligatoria) {
        await client.query(`UPDATE ${q(ref.hijo)} SET ${q(ref.col)} = NULL WHERE ${q(ref.col)} = $1`, [user.id]);
      } else {
        await borrarEnCascada(client, mapa, ref.hijo, `${q(ref.col)} = $1`, user.id, ['app_users']);
      }
    }
    await client.query(`DELETE FROM app_users WHERE id = $1`, [user.id]);

    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    // Que el panel diga qué tabla frenó el borrado.
    if (e.table || e.constraint || e.detail) {
      e.message = `${e.message}${e.detail ? ` — ${e.detail}` : ''}${e.table ? ` (tabla ${e.table})` : ''}`;
    }
    throw e;
  } finally {
    client.release();
  }

  return { ok: true, deleted: { email: user.email, businesses: bizRows.map((b) => b.name) } };
}

module.exports = { hardDeleteUser, getBusinessScopedTables, deleteWithRetry, borrarEnCascada, mapaDeReferencias };
