// services/superadminControlService.js
// Quién es super-admin (rol app_admin) y quién puede cambiarlo (pedido de la usuaria, 2026-11-10).
//
// - Cualquier super-admin ve la lista.
// - Dar o quitar el rol: SOLO la cuenta de control, y con un código de 6 dígitos que llega
//   únicamente al mail de control. El código queda atado a la acción (dar/quitar + email):
//   no sirve para otra cosa, vence a los 10 minutos y admite 5 intentos.
// - A la cuenta de control nadie le puede quitar el rol.
// - Dar el rol a una cuenta que ya usa negocios la dejaría sin poder entrar a ellos (un app_admin
//   no usa endpoints de negocio), así que se rechaza: tiene que ser una cuenta aparte. Si la
//   cuenta no existe, se crea y le llega un link para elegir su contraseña.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { sendEmail } = require('../utils/mailer');
const { logAudit } = require('./audit/auditLog');

const CONTROL_EMAIL = 'lazarillo.app2025@gmail.com';
const VENCE_MIN = 10;
const MAX_INTENTOS = 5;
const MAX_CODIGOS_POR_HORA = 6;

const normEmail = (e = '') => String(e).trim().toLowerCase();
const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const hashCodigo = (id, codigo) => crypto.createHash('sha256').update(`${id}:${codigo}`).digest('hex');

const FRONTEND_BASE_URL = (process.env.FRONTEND_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '');
const FRONTEND_BASE_PATH = (process.env.FRONTEND_BASE_PATH || '').replace(/\/+$/, '');
const urlFront = (p) => `${FRONTEND_BASE_URL}${FRONTEND_BASE_PATH}${p}`;

async function esControl(userId) {
  const { rows } = await pool.query('SELECT lower(email) AS email, role FROM app_users WHERE id = $1', [userId]);
  return rows[0]?.email === CONTROL_EMAIL && rows[0]?.role === 'app_admin';
}

async function listar(userId) {
  const { rows } = await pool.query(
    `SELECT id, email, COALESCE(name, '') AS name, status, created_at,
            (lower(email) = $1) AS control
       FROM app_users
      WHERE role = 'app_admin'
      ORDER BY (lower(email) = $1) DESC, lower(email)`, [CONTROL_EMAIL]);
  return { superadmins: rows, puedoEditar: await esControl(userId), controlEmail: CONTROL_EMAIL };
}

// Revisa si la acción se puede hacer (sin hacerla). Devuelve { error } o { cuenta }.
async function revisar(accion, email) {
  if (!['dar', 'quitar'].includes(accion)) return { error: 'accion_invalida' };
  if (!emailValido(email)) return { error: 'email_invalido' };
  const { rows } = await pool.query(
    'SELECT id, email, role FROM app_users WHERE lower(email) = $1 LIMIT 1', [email]);
  const cuenta = rows[0] || null;
  if (accion === 'quitar') {
    if (!cuenta || cuenta.role !== 'app_admin') return { error: 'no_es_superadmin' };
    if (email === CONTROL_EMAIL) return { error: 'es_la_cuenta_de_control' };
    return { cuenta };
  }
  if (cuenta?.role === 'app_admin') return { error: 'ya_es_superadmin' };
  if (cuenta) {
    const { rows: neg } = await pool.query(
      `SELECT 1 FROM app_businesses WHERE owner_id = $1
       UNION ALL
       SELECT 1 FROM user_assignments WHERE user_id = $1 AND revoked_at IS NULL
       LIMIT 1`, [cuenta.id]);
    if (neg[0]) return { error: 'cuenta_con_negocios' };
  }
  return { cuenta };
}

async function pedirCodigo(userId, accion, emailCrudo) {
  if (!(await esControl(userId))) return { error: 'solo_cuenta_control', status: 403 };
  const email = normEmail(emailCrudo);
  const r = await revisar(accion, email);
  if (r.error) return { error: r.error, status: 400 };

  const { rows: recientes } = await pool.query(
    `SELECT count(*)::int AS n FROM superadmin_codigos
      WHERE pedido_por = $1 AND created_at > now() - interval '1 hour'`, [userId]);
  if (recientes[0].n >= MAX_CODIGOS_POR_HORA) return { error: 'demasiados_codigos', status: 429 };

  // Un código nuevo anula los anteriores sin usar.
  await pool.query(
    'UPDATE superadmin_codigos SET usado_at = now() WHERE pedido_por = $1 AND usado_at IS NULL', [userId]);

  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const { rows } = await pool.query(
    `INSERT INTO superadmin_codigos (pedido_por, accion, objetivo, codigo_hash, expira_at)
     VALUES ($1, $2, $3, 'pendiente', now() + ($4 || ' minutes')::interval) RETURNING id`,
    [userId, accion, email, String(VENCE_MIN)]);
  const id = rows[0].id;
  await pool.query('UPDATE superadmin_codigos SET codigo_hash = $2 WHERE id = $1', [id, hashCodigo(id, codigo)]);

  const que = accion === 'dar' ? `darle acceso de super-admin a <b>${email}</b>` : `quitarle el acceso de super-admin a <b>${email}</b>`;
  const html = `
    <p>Se pidió ${que} en el panel de Lazarillo.</p>
    <p>Tu código es:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:6px">${codigo}</p>
    <p>Vence en ${VENCE_MIN} minutos. Si no fuiste vos, no lo uses y cambiá la contraseña de esta cuenta.</p>`;
  const envio = await sendEmail(CONTROL_EMAIL, `Código de control: ${codigo}`, html);
  if (envio.error || !(envio.accepted || []).length) return { error: 'no_se_pudo_enviar_mail', status: 502 };
  return { ok: true, simulado: !!envio.simulated, venceMin: VENCE_MIN };
}

async function confirmar(userId, accion, emailCrudo, codigoCrudo) {
  if (!(await esControl(userId))) return { error: 'solo_cuenta_control', status: 403 };
  const email = normEmail(emailCrudo);
  const codigo = String(codigoCrudo || '').replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT id, codigo_hash, intentos, expira_at < now() AS vencido
       FROM superadmin_codigos
      WHERE pedido_por = $1 AND accion = $2 AND objetivo = $3 AND usado_at IS NULL
      ORDER BY created_at DESC LIMIT 1`, [userId, accion, email]);
  const c = rows[0];
  if (!c) return { error: 'pedi_un_codigo', status: 400 };
  if (c.vencido) return { error: 'codigo_vencido', status: 400 };
  if (c.intentos >= MAX_INTENTOS) return { error: 'demasiados_intentos', status: 400 };
  const ok = codigo.length === 6 && crypto.timingSafeEqual(
    Buffer.from(hashCodigo(c.id, codigo)), Buffer.from(c.codigo_hash));
  if (!ok) {
    await pool.query('UPDATE superadmin_codigos SET intentos = intentos + 1 WHERE id = $1', [c.id]);
    return { error: 'codigo_incorrecto', status: 400, quedan: MAX_INTENTOS - c.intentos - 1 };
  }
  await pool.query('UPDATE superadmin_codigos SET usado_at = now() WHERE id = $1', [c.id]);

  // Se revisa de nuevo: algo pudo cambiar entre el pedido y la confirmación.
  const r = await revisar(accion, email);
  if (r.error) return { error: r.error, status: 400 };

  let resultado;
  if (accion === 'quitar') {
    await pool.query(`UPDATE app_users SET role = 'owner' WHERE id = $1`, [r.cuenta.id]);
    resultado = { email, quitado: true };
  } else if (r.cuenta) {
    await pool.query(`UPDATE app_users SET role = 'app_admin' WHERE id = $1`, [r.cuenta.id]);
    resultado = { email, dado: true, creada: false };
  } else {
    // Cuenta nueva: contraseña al azar que nadie conoce + link para elegir la suya (72 h).
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const passHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    await pool.query(
      `INSERT INTO app_users (name, email, password_hash, role, status, account_status, reset_token_hash, reset_token_expires_at)
       VALUES ($1, $2, $3, 'app_admin', 'active', 'active', $4, now() + interval '72 hours')`,
      [email.split('@')[0], email, passHash, tokenHash]);
    const link = urlFront(`/reset-password?token=${rawToken}&email=${encodeURIComponent(email)}`);
    const envio = await sendEmail(email, 'Tu acceso al panel de Lazarillo', `
      <p>Te dieron acceso de super-admin en Lazarillo.</p>
      <p>Elegí tu contraseña con este link (vale 72 horas):</p>
      <p><a href="${link}">${link}</a></p>`);
    resultado = { email, dado: true, creada: true, linkEnviado: !envio.error && (envio.accepted || []).length > 0 };
  }

  try {
    await logAudit(null, {
      userId, entityType: 'app_user', entityId: r.cuenta?.id || null, action: 'update',
      diff: { after: { email, role: accion === 'dar' ? 'app_admin' : 'owner' } },
      metadata: { tipo: accion === 'dar' ? 'superadmin_dar' : 'superadmin_quitar' },
    });
  } catch { /* la auditoría no frena el cambio */ }

  // Aviso al mail de control de que el cambio se hizo.
  sendEmail(CONTROL_EMAIL, accion === 'dar' ? `Nuevo super-admin: ${email}` : `Super-admin quitado: ${email}`,
    `<p>${accion === 'dar' ? 'Se dio' : 'Se quitó'} el acceso de super-admin a <b>${email}</b>.</p>`).catch(() => {});

  return { ok: true, ...resultado };
}

module.exports = { CONTROL_EMAIL, listar, pedirCodigo, confirmar, revisar, esControl };
