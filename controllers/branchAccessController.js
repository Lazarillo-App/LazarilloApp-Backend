// controllers/branchAccessController.js
//
// Vista Operación — QR de acceso por sucursal: un código fijo pegado en el
// local que solo permite PEDIR acceso (nunca da acceso por sí solo). La
// persona se registra sola (nombre + celular u email, confirmado por
// código), cae en la lista de pendientes del negocio, y el administrador la
// aprueba asignándole rol y sector.
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { sendEmail } = require('../utils/mailer');
const { sendCode } = require('../utils/smsClient');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

const OTP_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I, para leerlo bien impreso

function generarCodigo(len = 6) {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}
function generarOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function hashOtp(otp) {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

// La sucursal "principal" puede no existir todavía como fila real (el
// frontend la sintetiza como un branch virtual "main" hasta que alguien la
// edita) — mismo criterio que branchesController.updateMainBranch, pero acá
// solo hace falta que EXISTA una fila para poder colgarle el código.
async function resolveBranchId(client, businessId, branchIdParam) {
  if (branchIdParam !== 'main') {
    const id = num(branchIdParam);
    if (!id) return null;
    const { rows } = await client.query(
      `SELECT id FROM app_branches WHERE id = $1 AND business_id = $2`, [id, businessId]
    );
    return rows[0]?.id ?? null;
  }
  const { rows: existing } = await client.query(
    `SELECT id FROM app_branches
      WHERE business_id = $1 AND props IS NOT NULL AND (props->>'is_main')::boolean = true
      LIMIT 1`,
    [businessId]
  );
  if (existing.length) return existing[0].id;

  const { rows: bizRows } = await client.query(`SELECT name FROM app_businesses WHERE id = $1`, [businessId]);
  const nombre = bizRows[0]?.name || 'Principal';
  const { rows: created } = await client.query(
    `INSERT INTO app_branches (business_id, name, color, props)
     VALUES ($1, $2, '#64748b', '{"is_main": true}'::jsonb)
     RETURNING id`,
    [businessId, nombre]
  );
  return created[0].id;
}

/* ══════════════════════════════════════════════════════════
   ADMIN — generar / pausar / reanudar el acceso de una sucursal
   GET/POST /businesses/:businessId/branches/:branchId/access
══════════════════════════════════════════════════════════ */
exports.getOrCreateAccessCode = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const businessId = num(req.params.businessId);
    if (!businessId) return res.status(400).json({ ok: false, error: 'business_id requerido' });

    await client.query('BEGIN');
    const branchId = await resolveBranchId(client, businessId, req.params.branchId);
    if (!branchId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'branch_not_found' });
    }

    const { rows: existing } = await client.query(
      `SELECT * FROM branch_access_codes WHERE branch_id = $1`, [branchId]
    );

    let row;
    if (existing.length) {
      row = existing[0];
    } else {
      let code;
      for (let i = 0; i < 8; i++) {
        code = generarCodigo();
        const { rows: dup } = await client.query(`SELECT 1 FROM branch_access_codes WHERE code = $1`, [code]);
        if (!dup.length) break;
        code = null;
      }
      if (!code) throw new Error('no_se_pudo_generar_codigo');
      const { rows } = await client.query(
        `INSERT INTO branch_access_codes (branch_id, business_id, code, created_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [branchId, businessId, code, req.user?.id || null]
      );
      row = rows[0];
    }
    await client.query('COMMIT');

    res.json({
      ok: true,
      accessCode: { code: row.code, active: row.active, branchId },
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[branchAccess] getOrCreateAccessCode error:', e);
    next(e);
  } finally {
    client.release();
  }
};

exports.setAccessCodeActive = async (req, res, next) => {
  try {
    const businessId = num(req.params.businessId);
    const active = !!req.body?.active;
    if (!businessId) return res.status(400).json({ ok: false, error: 'business_id requerido' });

    const client = pool;
    const branchId = await resolveBranchId(client, businessId, req.params.branchId);
    if (!branchId) return res.status(404).json({ ok: false, error: 'branch_not_found' });

    const { rows } = await pool.query(
      `UPDATE branch_access_codes SET active = $1 WHERE branch_id = $2 RETURNING code, active`,
      [active, branchId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'access_code_not_found' });
    res.json({ ok: true, accessCode: rows[0] });
  } catch (e) {
    console.error('[branchAccess] setAccessCodeActive error:', e);
    next(e);
  }
};

/* ══════════════════════════════════════════════════════════
   PÚBLICO — sin auth
══════════════════════════════════════════════════════════ */

// GET /public/access/:code
exports.resolveCode = async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const { rows } = await pool.query(
      `SELECT bac.active, bac.branch_id, b.id AS business_id, b.name AS business_name,
              br.name AS branch_name
         FROM branch_access_codes bac
         JOIN app_businesses b ON b.id = bac.business_id
         LEFT JOIN app_branches br ON br.id = bac.branch_id
        WHERE bac.code = $1`,
      [code]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'code_not_found' });
    const r = rows[0];
    if (!r.active) return res.status(410).json({ ok: false, error: 'code_paused' });

    res.json({
      ok: true,
      businessId: Number(r.business_id),
      businessName: r.business_name,
      branchName: r.branch_name,
    });
  } catch (e) {
    console.error('[branchAccess] resolveCode error:', e);
    next(e);
  }
};

// POST /public/access/:code/request  { nombre, canal: 'celular'|'email', valor }
exports.requestAccess = async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const nombre = String(req.body?.nombre || '').trim();
    const canal = req.body?.canal === 'email' ? 'email' : 'celular';
    const valor = String(req.body?.valor || '').trim();

    if (!nombre) return res.status(400).json({ ok: false, error: 'nombre_requerido' });
    if (!valor) return res.status(400).json({ ok: false, error: 'valor_requerido' });

    const { rows: codeRows } = await pool.query(
      `SELECT * FROM branch_access_codes WHERE code = $1 AND active = TRUE`, [code]
    );
    if (!codeRows.length) return res.status(404).json({ ok: false, error: 'code_not_found' });
    const ac = codeRows[0];

    const otp = generarOtp();
    const otpHash = hashOtp(otp);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    const { rows } = await pool.query(
      `INSERT INTO access_requests
         (branch_access_code_id, business_id, branch_id, nombre, celular, email, canal,
          otp_code_hash, otp_expires_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_otp')
       RETURNING id`,
      [ac.id, ac.business_id, ac.branch_id, nombre,
        canal === 'celular' ? valor : null,
        canal === 'email' ? valor : null,
        canal, otpHash, expiresAt]
    );
    const requestId = rows[0].id;

    const texto = `Tu código para entrar a Lazarillo es ${otp}. Vence en 10 minutos.`;
    if (canal === 'celular') {
      await sendCode('whatsapp', valor, texto);
    } else {
      await sendEmail(valor, 'Tu código de Lazarillo', `<p>${texto}</p>`);
    }

    res.status(201).json({ ok: true, requestId, canal });
  } catch (e) {
    console.error('[branchAccess] requestAccess error:', e);
    next(e);
  }
};

// POST /public/access/:code/confirm  { requestId, otp, password }
exports.confirmAccess = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const requestId = num(req.body?.requestId);
    const otp = String(req.body?.otp || '').trim();
    const password = String(req.body?.password || '');
    if (!requestId || !otp) return res.status(400).json({ ok: false, error: 'missing_fields' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM access_requests WHERE id = $1 AND status = 'pending_otp' FOR UPDATE`,
      [requestId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'request_not_found' });
    }
    const reqRow = rows[0];

    if (new Date(reqRow.otp_expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'otp_expired' });
    }
    if (hashOtp(otp) !== reqRow.otp_code_hash) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'otp_invalid' });
    }

    // Email pide contraseña (como siempre); celular también — el login sin
    // contraseña queda para más adelante, por ahora toda cuenta se crea con clave.
    if (!password || password.length < 6) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'password_required' });
    }

    const contacto = reqRow.email || reqRow.celular;
    let userId;
    if (reqRow.email) {
      const { rows: existingUser } = await client.query(
        `SELECT id FROM app_users WHERE email = $1 LIMIT 1`, [reqRow.email]
      );
      if (existingUser.length) {
        userId = existingUser[0].id;
      } else {
        const hash = await bcrypt.hash(password, 10);
        const { rows: created } = await client.query(
          `INSERT INTO app_users (name, email, password_hash, account_status, role)
           VALUES ($1, $2, $3, 'active', 'staff') RETURNING id`,
          [reqRow.nombre, reqRow.email, hash]
        );
        userId = created[0].id;
      }
    } else {
      // Alta por celular: no hay email — se guarda un email sintético único
      // para no romper la columna (mismo criterio que otras altas manuales de
      // este proyecto usan un identificador provisorio hasta reconciliar).
      const hash = await bcrypt.hash(password, 10);
      const emailSintetico = `celular-${reqRow.celular.replace(/[^0-9]/g, '')}@sin-email.lazarillo.local`;
      const { rows: created } = await client.query(
        `INSERT INTO app_users (name, email, password_hash, phone, account_status, role)
         VALUES ($1, $2, $3, $4, 'active', 'staff') RETURNING id`,
        [reqRow.nombre, emailSintetico, hash, reqRow.celular]
      );
      userId = created[0].id;
    }

    await client.query(
      `UPDATE access_requests
          SET status = 'pending_approval', confirmed_at = NOW(), user_id = $1
        WHERE id = $2`,
      [userId, requestId]
    );
    await client.query('COMMIT');

    res.json({ ok: true, businessId: reqRow.business_id, contacto });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[branchAccess] confirmAccess error:', e);
    next(e);
  } finally {
    client.release();
  }
};

/* ══════════════════════════════════════════════════════════
   ADMIN — pendientes del negocio
══════════════════════════════════════════════════════════ */

// GET /businesses/:businessId/access-requests
exports.listPendientes = async (req, res, next) => {
  try {
    const businessId = num(req.params.businessId);
    if (!businessId) return res.status(400).json({ ok: false, error: 'business_id requerido' });

    const { rows } = await pool.query(
      `SELECT ar.id, ar.nombre, ar.celular, ar.email, ar.canal, ar.confirmed_at,
              br.name AS branch_name
         FROM access_requests ar
         LEFT JOIN app_branches br ON br.id = ar.branch_id
        WHERE ar.business_id = $1 AND ar.status = 'pending_approval'
        ORDER BY ar.confirmed_at ASC`,
      [businessId]
    );
    res.json({ ok: true, pendientes: rows });
  } catch (e) {
    console.error('[branchAccess] listPendientes error:', e);
    next(e);
  }
};

// POST /access-requests/:requestId/approve  { role: 'admin'|'staff', sectorIds?: number[] }
exports.approveRequest = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const requestId = num(req.params.requestId);
    const role = req.body?.role === 'admin' ? 'admin' : 'staff';
    const sectorIds = role === 'staff' && Array.isArray(req.body?.sectorIds)
      ? [...new Set(req.body.sectorIds.map(Number).filter(Number.isFinite))]
      : null;
    if (!requestId) return res.status(400).json({ ok: false, error: 'request_id requerido' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM access_requests WHERE id = $1 AND status = 'pending_approval' FOR UPDATE`,
      [requestId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'request_not_found' });
    }
    const reqRow = rows[0];

    if (sectorIds?.length) {
      const { rows: secRows } = await client.query(
        `SELECT id FROM sectores WHERE id = ANY($1::int[]) AND business_id = $2`,
        [sectorIds, reqRow.business_id]
      );
      const validSet = new Set(secRows.map((r) => Number(r.id)));
      if (sectorIds.some((id) => !validSet.has(id))) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'invalid_sector' });
      }
    }

    // Mismo criterio que teamController.createInvitation: chequear a mano en
    // vez de asumir una constraint UNIQUE que puede no existir en esta tabla.
    const { rows: existingAssign } = await client.query(
      `SELECT id FROM user_assignments
        WHERE user_id = $1 AND scope_type = 'business' AND scope_id = $2 AND role = $3
        LIMIT 1`,
      [reqRow.user_id, reqRow.business_id, role]
    );
    if (existingAssign.length) {
      await client.query(
        `UPDATE user_assignments
            SET revoked_at = NULL, alias = $1, granted_by_user_id = $2, sector_ids = $3, updated_at = NOW()
          WHERE id = $4`,
        [reqRow.nombre, req.user?.id || null, sectorIds, existingAssign[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO user_assignments (user_id, scope_type, scope_id, role, alias, granted_by_user_id, sector_ids)
         VALUES ($1, 'business', $2, $3, $4, $5, $6)`,
        [reqRow.user_id, reqRow.business_id, role, reqRow.nombre, req.user?.id || null, sectorIds]
      );
    }

    await client.query(
      `UPDATE access_requests SET status = 'approved', decided_at = NOW(), decided_by = $1 WHERE id = $2`,
      [req.user?.id || null, requestId]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[branchAccess] approveRequest error:', e);
    next(e);
  } finally {
    client.release();
  }
};

// POST /access-requests/:requestId/reject
exports.rejectRequest = async (req, res, next) => {
  try {
    const requestId = num(req.params.requestId);
    if (!requestId) return res.status(400).json({ ok: false, error: 'request_id requerido' });

    const { rows } = await pool.query(
      `UPDATE access_requests
          SET status = 'rejected', decided_at = NOW(), decided_by = $1
        WHERE id = $2 AND status = 'pending_approval'
        RETURNING id`,
      [req.user?.id || null, requestId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'request_not_found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[branchAccess] rejectRequest error:', e);
    next(e);
  }
};
