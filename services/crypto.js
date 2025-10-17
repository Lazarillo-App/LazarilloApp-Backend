// services/crypto.js  (o utils/crypto si preferís)
const crypto = require('crypto');

function resolveKey() {
  const raw = String(process.env.ENCRYPTION_KEY || 'fallback_key').trim();
  // Si viene 64 hex -> úsalo directo; si no, deriva desde passphrase con SHA-256
  return /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : crypto.createHash('sha256').update(raw).digest();
}

exports.encryptText = (plain) => {
  const key = resolveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv:tag:data (base64) => más depurable que el blob único
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
};

exports.decryptText = (payload) => {
  const key = resolveKey();
  const s = String(payload || '').trim();
  if (!s) return '';
  // Soportá viejo formato blob base64 por compat
  if (!s.includes(':')) {
    const raw = Buffer.from(s, 'base64');
    const iv  = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  }
  const [ivB64, tagB64, dataB64] = s.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8');
};
