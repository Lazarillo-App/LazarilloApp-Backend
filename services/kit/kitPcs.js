// services/kit/kitPcs.js
// Kit vinculado sin Drive (Diego, 07-08/11/2026): cada PC con MaxiRest se vincula una vez con
// usuario y contraseña de un dueño/admin y recibe SU llave. Reglas de Diego:
//   - La vinculación exige rol dueño o admin del negocio.
//   - Un local (negocio + sucursal) tiene UNA sola PC activa. Un local ocupado se ve pero no se
//     elige; tomarlo es "Reemplazar esa PC" (corta la llave de la vieja). Lo asegura también el
//     índice único de kit_pcs (aunque corran dos instaladores a la vez).
//   - La misma PC que se reinstala (misma huella) renueva su llave sin duplicar.
//   - La contraseña no se guarda: la PC queda con una llave revocable que solo sirve para subir
//     los datos de su local. En la base va solo el sha256 de la llave.
//   - Sistema: solo MaxiRest por ahora.
// El destino de los datos es el mismo de siempre: esquema de la organización + columna pdv, y la
// fila en gestion_render_origenes (con la que Balance lee lo que sube cada PDV).
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const { listAccessibleBusinesses } = require('../auth/accessControl');
const { getPermisos, puedeSeccion } = require('../auth/permisos');

const PREFIJO = 'lzk_';
const ROLES_QUE_VINCULAN = new Set(['owner', 'admin']);
const ESQUEMAS_PROHIBIDOS = new Set(['public', 'information_schema', 'pg_catalog', 'pg_toast']);

const hashLlave = (llave) => crypto.createHash('sha256').update(String(llave)).digest('hex');

function nuevaLlave() {
  const llave = PREFIJO + crypto.randomBytes(32).toString('base64url');
  return { llave, hash: hashLlave(llave), pista: llave.slice(-4) };
}

// "Palermo suites" -> "palermo_suites" (esquema) / "PALERMOSUITES" (pdv, como BAR o FCRAMOS)
function slug(txt) {
  return String(txt || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
const esIdent = (s) => /^[a-z_][a-z0-9_]{0,62}$/.test(s);

// ---------------------------------------------------------------- login
// Mismo control que /api/auth/login (email + bcrypt, cuenta no suspendida). Devuelve el
// usuario o null. No firma ningún token: el instalador manda usuario y contraseña en cada uno
// de sus dos pasos (por HTTPS) y la contraseña no queda en ningún lado.
async function verificarUsuario(email, password) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !password) return null;
  const { rows } = await pool.query(
    `SELECT id, email, name, display_name, password_hash, account_status
       FROM app_users WHERE email = $1 LIMIT 1`, [e]);
  const u = rows[0];
  if (!u || !u.password_hash || u.account_status === 'suspended') return null;
  const ok = await bcrypt.compare(String(password), u.password_hash);
  return ok ? u : null;
}

// ---------------------------------------------------------------- locales
// Locales donde el usuario es dueño o admin: cada negocio (su local principal) y cada sucursal
// secundaria. Cada uno dice si ya tiene PC (ocupado) para que el instalador lo muestre en gris.
async function localesDe(userId) {
  const accesos = await listAccessibleBusinesses(userId);
  const rolPorNegocio = new Map();
  const NIVEL = { owner: 3, admin: 2, staff: 1 };
  for (const a of accesos) {
    const id = Number(a.business_id);
    const prev = rolPorNegocio.get(id);
    if (!prev || (NIVEL[a.role] ?? 0) > (NIVEL[prev] ?? 0)) rolPorNegocio.set(id, a.role);
  }
  const candidatos = [...rolPorNegocio].filter(([, r]) => ROLES_QUE_VINCULAN.has(r));
  // Un admin con rol a medida vincula solo si su rol tiene Conexiones en "Editar".
  const ids = [];
  for (const [id, r] of candidatos) {
    if (r === 'admin' && !puedeSeccion(await getPermisos(userId, id), 'conexiones', 'editar')) continue;
    ids.push(id);
  }
  if (!ids.length) return [];

  const { rows: negocios } = await pool.query(
    `SELECT b.id, b.name, b.organization_id, o.name AS org
       FROM app_businesses b LEFT JOIN organizations o ON o.id = b.organization_id
      WHERE b.id = ANY($1::bigint[]) AND b.paused_at IS NULL
      ORDER BY o.name NULLS LAST, b.name`, [ids]);
  const { rows: sucursales } = await pool.query(
    `SELECT id, business_id, name FROM app_branches
      WHERE business_id = ANY($1::bigint[])
        AND NOT COALESCE((props->>'is_main')::boolean, false)
      ORDER BY business_id, name`, [ids]);
  const { rows: pcs } = await pool.query(
    `SELECT business_id, branch_id, pc_nombre, ultimo_contacto, maestros, esquema
       FROM kit_pcs WHERE revocado_en IS NULL AND business_id = ANY($1::bigint[])`, [ids]);
  const ocupado = (biz, br) => {
    const p = pcs.find((x) => Number(x.business_id) === Number(biz) && Number(x.branch_id || 0) === Number(br || 0));
    return p ? { pc: p.pc_nombre, ultimoContacto: p.ultimo_contacto } : null;
  };

  const out = [];
  for (const n of negocios) {
    out.push({ businessId: Number(n.id), branchId: null, nombre: n.name, sucursal: null,
      organizacion: n.org || null, rol: rolPorNegocio.get(Number(n.id)), pos: 'maxirest',
      ocupado: ocupado(n.id, null) });
    for (const s of sucursales.filter((x) => Number(x.business_id) === Number(n.id))) {
      out.push({ businessId: Number(n.id), branchId: Number(s.id), nombre: n.name, sucursal: s.name,
        organizacion: n.org || null, rol: rolPorNegocio.get(Number(n.id)), pos: 'maxirest',
        ocupado: ocupado(n.id, s.id) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- destino (esquema + pdv)
// Si el local ya sube por el kit del Drive (gestion_render_origenes), se usa lo mismo: así,
// cuando una PC de hoy pase a la vinculación, sigue escribiendo en el mismo lugar.
// Si es nuevo: el esquema es el de su organización (el que ya usen otros PDV de la misma
// organización, o uno nuevo con el nombre de la organización; sin organización, el del
// negocio) y el pdv sale del nombre del negocio (+ sucursal).
async function destinoDe(client, businessId, branchId) {
  const { rows: ya } = await client.query(
    `SELECT id, esquema, pdv FROM gestion_render_origenes
      WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $2 ORDER BY activo DESC, id LIMIT 1`,
    [businessId, branchId]);
  if (ya[0]) {
    await client.query('UPDATE gestion_render_origenes SET activo = true WHERE id = $1', [ya[0].id]);
    return { origenId: ya[0].id, esquema: ya[0].esquema, pdv: ya[0].pdv, nuevo: false };
  }

  const { rows: nb } = await client.query(
    `SELECT b.id, b.name, b.organization_id, o.name AS org
       FROM app_businesses b LEFT JOIN organizations o ON o.id = b.organization_id WHERE b.id = $1`,
    [businessId]);
  const neg = nb[0];
  if (!neg) throw Object.assign(new Error('business_not_found'), { status: 404 });
  let sucursal = null;
  if (branchId != null) {
    const { rows } = await client.query('SELECT id, name, business_id FROM app_branches WHERE id = $1', [branchId]);
    if (!rows[0] || Number(rows[0].business_id) !== Number(businessId)) {
      throw Object.assign(new Error('branch_not_in_business'), { status: 400 });
    }
    sucursal = rows[0].name;
  }

  let esquema = null;
  if (neg.organization_id) {
    const { rows } = await client.query(
      `SELECT o.esquema FROM gestion_render_origenes o JOIN app_businesses b ON b.id = o.business_id
        WHERE b.organization_id = $1 ORDER BY o.id LIMIT 1`, [neg.organization_id]);
    esquema = rows[0]?.esquema || null;
  }
  if (!esquema) {
    const base = slug(neg.org || neg.name) || `negocio_${businessId}`;
    esquema = /^[a-z_]/.test(base) ? base : `n_${base}`;
    esquema = esquema.slice(0, 50);
    // No pisar un esquema que ya existe y no es de esta organización (ni uno del sistema).
    for (let k = 0; ; k++) {
      const cand = k === 0 ? esquema : `${esquema}_${k + 1}`;
      if (ESQUEMAS_PROHIBIDOS.has(cand) || cand.startsWith('pg_')) continue;
      const { rows: enUso } = await client.query(
        `SELECT 1 FROM pg_namespace WHERE nspname = $1
          UNION ALL SELECT 1 FROM gestion_render_origenes WHERE esquema = $1 LIMIT 1`, [cand]);
      if (!enUso.length) { esquema = cand; break; }
    }
  }
  if (!esIdent(esquema)) throw Object.assign(new Error('esquema_invalido'), { status: 500 });

  let pdv = slug(sucursal ? `${neg.name} ${sucursal}` : neg.name).replace(/_/g, '').toUpperCase().slice(0, 30)
    || `NEG${businessId}`;
  for (let k = 0; ; k++) {
    const cand = k === 0 ? pdv : `${pdv}${k + 1}`;
    const { rows } = await client.query(
      'SELECT 1 FROM gestion_render_origenes WHERE esquema = $1 AND pdv = $2', [esquema, cand]);
    if (!rows.length) { pdv = cand; break; }
  }
  const { rows: ins } = await client.query(
    `INSERT INTO gestion_render_origenes (esquema, pdv, business_id, branch_id, activo)
     VALUES ($1, $2, $3, $4, true) RETURNING id`, [esquema, pdv, businessId, branchId]);
  return { origenId: ins[0].id, esquema, pdv, nuevo: true };
}

// ---------------------------------------------------------------- vincular
// opciones: { businessId, branchId, pc, huella, maestros, reemplazar }
// Errores con .status: 403 rol, 409 'ocupado' (con .ocupado = { pc }), 400 datos.
async function vincular(usuario, op) {
  const businessId = Number(op.businessId);
  const branchId = op.branchId == null || op.branchId === '' ? null : Number(op.branchId);
  const pc = String(op.pc || '').trim().slice(0, 64);
  const huella = op.huella ? String(op.huella).trim().slice(0, 128) : null;
  if (!Number.isFinite(businessId) || businessId <= 0 || !pc) {
    throw Object.assign(new Error('datos_incompletos'), { status: 400 });
  }
  const local = (await localesDe(usuario.id))
    .find((l) => l.businessId === businessId && (l.branchId ?? null) === branchId);
  if (!local) throw Object.assign(new Error('sin_permiso'), { status: 403 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Un candado por local: dos instaladores a la vez sobre el mismo local esperan en fila.
    await client.query('SELECT pg_advisory_xact_lock(7320000, hashtext($1))', [`${businessId}:${branchId || 0}`]);

    const { rows: activos } = await client.query(
      `SELECT id, pc_nombre, pc_huella, maestros FROM kit_pcs
        WHERE revocado_en IS NULL AND business_id = $1 AND COALESCE(branch_id, 0) = COALESCE($2::bigint, 0)
        FOR UPDATE`, [businessId, branchId]);
    const actual = activos[0] || null;
    const mismaPc = actual && huella && actual.pc_huella && actual.pc_huella === huella;
    if (actual && !mismaPc && !op.reemplazar) {
      throw Object.assign(new Error('ocupado'), { status: 409, ocupado: { pc: actual.pc_nombre } });
    }
    if (actual) {
      await client.query(
        `UPDATE kit_pcs SET revocado_en = now(), revocado_por = $2, revocado_motivo = $3 WHERE id = $1`,
        [actual.id, usuario.id, mismaPc ? 'reinstalada' : `reemplazada por ${pc}`]);
    }

    const destino = await destinoDe(client, businessId, branchId);

    // Maestros: uno por esquema. Si otra PC ya los arma, esta no (se avisa).
    let maestros = !!op.maestros;
    let avisoMaestros = null;
    if (maestros) {
      const { rows } = await client.query(
        `SELECT pc_nombre FROM kit_pcs WHERE revocado_en IS NULL AND maestros AND esquema = $1`,
        [destino.esquema]);
      if (rows[0]) { maestros = false; avisoMaestros = `Los maestros ya los arma ${rows[0].pc_nombre}`; }
    }

    const ll = nuevaLlave();
    const { rows: nueva } = await client.query(
      `INSERT INTO kit_pcs (business_id, branch_id, origen_id, esquema, pdv, pos, pc_nombre, pc_huella,
                            maestros, llave_hash, llave_pista, creado_por)
       VALUES ($1,$2,$3,$4,$5,'maxirest',$6,$7,$8,$9,$10,$11) RETURNING id`,
      [businessId, branchId, destino.origenId, destino.esquema, destino.pdv, pc, huella, maestros,
        ll.hash, ll.pista, usuario.id]);
    await client.query('COMMIT');
    return {
      pcId: nueva[0].id, llave: ll.llave, esquema: destino.esquema, pdv: destino.pdv, maestros,
      avisoMaestros, reemplazo: actual && !mismaPc ? actual.pc_nombre : null,
      negocio: local.nombre, sucursal: local.sucursal,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') throw Object.assign(new Error('ocupado'), { status: 409, ocupado: {} });
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- llave → PC
async function pcPorLlave(llave) {
  if (!llave || !String(llave).startsWith(PREFIJO)) return null;
  const { rows } = await pool.query(
    `SELECT p.*, b.name AS negocio, br.name AS sucursal
       FROM kit_pcs p JOIN app_businesses b ON b.id = p.business_id
       LEFT JOIN app_branches br ON br.id = p.branch_id
      WHERE p.llave_hash = $1 AND p.revocado_en IS NULL LIMIT 1`, [hashLlave(llave)]);
  return rows[0] || null;
}

async function tocar(pcId, motorVer) {
  await pool.query(
    `UPDATE kit_pcs SET ultimo_contacto = now(), motor_ver = COALESCE($2, motor_ver)
      WHERE id = $1 AND (ultimo_contacto IS NULL OR ultimo_contacto < now() - interval '1 minute'
                         OR motor_ver IS DISTINCT FROM COALESCE($2, motor_ver))`,
    [pcId, motorVer ? String(motorVer).slice(0, 20) : null]);
}

// ---------------------------------------------------------------- app (Configuración › Conexiones)
async function listarPcs(businessId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.branch_id, br.name AS sucursal, p.pdv, p.esquema, p.pos, p.pc_nombre, p.maestros,
            p.creado_en, u.email AS creado_por, p.ultimo_contacto, p.ultima_carga, p.ultima_carga_detalle,
            p.motor_ver, p.revocado_en, p.revocado_motivo
       FROM kit_pcs p LEFT JOIN app_branches br ON br.id = p.branch_id
       LEFT JOIN app_users u ON u.id = p.creado_por
      WHERE p.business_id = $1 AND (p.revocado_en IS NULL OR p.revocado_en > now() - interval '30 days')
      ORDER BY p.revocado_en NULLS FIRST, p.creado_en DESC`, [businessId]);
  return rows;
}

async function desvincular(businessId, pcId, userId) {
  const { rowCount } = await pool.query(
    `UPDATE kit_pcs SET revocado_en = now(), revocado_por = $3, revocado_motivo = 'desvinculada desde la app'
      WHERE id = $1 AND business_id = $2 AND revocado_en IS NULL`, [pcId, businessId, userId]);
  return rowCount > 0;
}

module.exports = {
  PREFIJO, hashLlave, slug, verificarUsuario, localesDe, vincular, pcPorLlave, tocar, listarPcs, desvincular,
};
