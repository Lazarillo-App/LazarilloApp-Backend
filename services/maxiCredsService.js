// src/services/maxiCredsService.js
const pool = require('../config/db');
const { encryptText, decryptText } = require('../services/crypto');
const { decryptSecretCompat } = require('../utils/cryptoField'); // compat viejo

function encrypt(plain) {
  return encryptText(plain); // usa el helper unificado
}

// Acepta iv:tag:data (nuevo) y los formatos viejos que tenías en decryptSecretCompat
function decryptCompat(encStr) {
  if (!encStr) return null;
  // 1) Nuevo formato y blob viejo (lo maneja decryptText)
  try { return decryptText(encStr); } catch {}
  // 2) Compat JSON base64 {v,iv,tag,ct} o lo que tengas en compat
  try {
    const out = decryptSecretCompat(encStr);
    return out || null;
  } catch { return null; }
}

async function saveCreds(businessId, { email, codcli, pass, pass_enc }) {
  if (!businessId) throw new Error('businessId requerido');
  const e = String(email || '').trim();
  const c = String(codcli || '').trim();
  if (!e || !c || (!pass && !pass_enc)) throw new Error('missing_fields');

  const toStore = {
    email: e,
    codcli: c,
    pass_enc: pass_enc || encrypt(pass),
  };

  await pool.query(
    `UPDATE app_businesses
        SET props = COALESCE(props, '{}'::jsonb) || jsonb_build_object('maxi', $2::jsonb)
      WHERE id = $1`,
    [businessId, JSON.stringify(toStore)]
  );
}

async function getCreds(businessId) {
  const { rows } = await pool.query('SELECT props FROM app_businesses WHERE id=$1 LIMIT 1', [businessId]);
  const mx = rows[0]?.props?.maxi || null;
  if (!mx) return null;

  return {
    email: mx.email || null,
    cod_cli: mx.cod_cli || mx.codcli || null,
    pass: mx.pass || mx.password || null,  // texto en claro si existiera
    pass_enc: mx.pass_enc || null,
  };
}

async function getStatus(businessId) {
  const c = await getCreds(businessId);
  const configured = !!(c && c.email && (c.cod_cli) && (c.pass || c.pass_enc));
  return {
    configured,
    email: c?.email || null,
    codcli: c?.cod_cli || null,
  };
}

module.exports = { saveCreds, getCreds, getStatus, decryptCompat };
