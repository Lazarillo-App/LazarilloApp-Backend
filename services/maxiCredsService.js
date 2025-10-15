// src/services/maxiCredsService.js
const pool = require('../config/db');
const crypto = require('crypto');
const { decryptSecretCompat } = require('../utils/cryptoField');


const ENC_KEY_HEX = process.env.ENCRYPTION_KEY; // 32 bytes en hex
function ensureKey() {
  const hex = String(ENC_KEY_HEX || '').trim();
  if (!hex || hex.length !== 64) throw new Error('ENCRYPTION_KEY inválida (debe ser 32 bytes en hex).');
  return Buffer.from(hex, 'hex');
}

function encrypt(plain) {
  const key = ensureKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // formato: iv:tag:data (base64)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptCompat(encStr) {
  const key = ensureKey();
  const s = String(encStr || '').trim();
  if (!s) return null;

  // a) Formato "iv:tag:data"
  if (s.includes(':')) {
    const [ivB64, tagB64, dataB64] = s.split(':');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  }

  // b) Formato base64(JSON con {v,iv,tag,ct})
  try {
    const jsonStr = Buffer.from(s, 'base64').toString('utf8');
    const obj = JSON.parse(jsonStr);
    const iv  = Buffer.from(obj.iv,  'base64');
    const tag = Buffer.from(obj.tag, 'base64');
    const ct  = Buffer.from(obj.ct,  'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}


/**
 * Guarda credenciales en app_businesses.props.maxi
 */
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
    `
    UPDATE app_businesses
       SET props = COALESCE(props, '{}'::jsonb) || jsonb_build_object('maxi', $2::jsonb)
     WHERE id = $1
    `,
    [businessId, JSON.stringify(toStore)]
  );
}

/**
 * Lee credenciales desde props.maxi
 * Retorna { email, codcli, pass } si hay datos, sino null
 */
async function getCreds(businessId) {
  const { rows } = await pool.query('SELECT props FROM app_businesses WHERE id=$1 LIMIT 1', [businessId]);
  const mx = rows[0]?.props?.maxi || {};
  return {
    email: mx.email || null,
    cod_cli: mx.cod_cli || mx.codcli || null,
    // dejamos pasar todas las variantes para que getBearer resuelva
    pass: mx.pass || null,
    password: mx.password || null,
    pass_enc: mx.pass_enc || null,
  };
}

/**
 * Estado simple para UI/diagnóstico
 */
async function getStatus(businessId) {
  const c = await getCreds(businessId);
  return {
    configured: !!c,
    email: c?.email || null,
    codcli: c?.cod_cli || c?.codcli || null,
  };
}

module.exports = { saveCreds, getCreds, getStatus };

