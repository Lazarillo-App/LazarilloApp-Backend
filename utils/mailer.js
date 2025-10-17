// utils/cryptoField.js
const crypto = require('crypto');

function resolveKey() {
  const raw = String(process.env.ENCRYPTION_KEY || 'dev-key').trim();
  return /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')                          // 32 bytes hex
    : crypto.createHash('sha256').update(raw).digest(); // 32 bytes desde passphrase
}
const KEY = resolveKey();

// ============ NUEVO: AES-256-GCM (JSON -> base64) ============
function encryptSecret(plain = '') {
  const iv = crypto.randomBytes(12);
  const ciph = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([ciph.update(String(plain), 'utf8'), ciph.final()]);
  const tag = ciph.getAuthTag();
  const payload = { v: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function decryptSecret(b64 = '') {
  try {
    const txt = Buffer.from(b64, 'base64').toString('utf8');
    const payload = JSON.parse(txt);
    const iv  = Buffer.from(payload.iv,  'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const ct  = Buffer.from(payload.ct,  'base64');
    const dec = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    dec.setAuthTag(tag);
    return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
  } catch {
    return null; // ← más claro para el caller
  }
}

// ============ COMPAT: AES-CTR (HEX plano) ============
const LEGACY_IV = Buffer.alloc(16, 0); // 16 bytes 0x00 (igual que antes)

function decryptSecretCompat(value = '') {
  const s = String(value || '').trim();
  if (!s) return null;

  // ¿Nuevo formato base64->JSON?
  const maybe = decryptSecret(s);
  if (typeof maybe === 'string') return maybe;

  // ¿Viejo formato HEX?
  if (/^[0-9a-f]{2,}$/i.test(s) && s.length % 2 === 0) {
    try {
      const dec = crypto.createDecipheriv('aes-256-ctr', KEY, LEGACY_IV);
      return Buffer.concat([dec.update(Buffer.from(s, 'hex')), dec.final()]).toString('utf8');
    } catch {}
  }

  return null;
}

module.exports = { encryptSecret, decryptSecret, decryptSecretCompat };
