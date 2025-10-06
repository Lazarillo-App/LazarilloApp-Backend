// Lee credenciales de Maxi desde app_businesses.props.maxi
// Formatos soportados en props.maxi:
//   { email, pass, codcli }                -> pass en texto (dev/local)
//   { email, pass_enc, codcli }            -> pass cifrada (prod)
// Si ambas existen, prioriza pass (texto). Fallback a .env si falta algo.

const pool = require('../config/db');
const crypto = require('crypto');

const KEY_HEX = process.env.ENCRYPTION_KEY || ''; // opcional (para pass_enc)

function decryptGCM(hex, keyHex = KEY_HEX) {
  try {
    if (!hex || !keyHex) return null;
    // Esperamos formato hex "iv:cipher:tag" (común en AES-256-GCM)
    const [ivHex, cipherHex, tagHex] = String(hex).split(':');
    if (!ivHex || !cipherHex || !tagHex) return null;

    const key = Buffer.from(keyHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const enc = Buffer.from(cipherHex, 'hex');

    const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
    dec.setAuthTag(tag);
    const out = Buffer.concat([dec.update(enc), dec.final()]);
    return out.toString('utf8');
  } catch (_e) {
    // No rompas el flujo: devolvé null si no se puede descifrar
    return null;
  }
}

/**
 * Devuelve { email, pass, cod_cli } o null si faltan datos.
 * @param {number} businessId
 */
async function getCreds(businessId) {
  if (!Number.isFinite(Number(businessId))) return null;

  const { rows } = await pool.query(
    'SELECT props FROM app_businesses WHERE id = $1 LIMIT 1',
    [Number(businessId)]
  );
  const props = rows[0]?.props || {};
  const maxi = props?.maxi || {};

  let email = String(maxi.email || '').trim();
  let cod_cli = String(maxi.codcli || maxi.cod_cli || '').trim();

  // Prioriza pass en texto si está; si no, intenta descifrar pass_enc
  let pass = '';
  if (maxi.pass) {
    pass = String(maxi.pass);
  } else if (maxi.pass_enc) {
    pass = decryptGCM(String(maxi.pass_enc)) || '';
  }

  // Normalización campo cod_cli
  if (!cod_cli && maxi.codCliente) cod_cli = String(maxi.codCliente).trim();

  if (!email || !pass || !cod_cli) return null;
  return { email, pass, cod_cli };
}

module.exports = { getCreds };
