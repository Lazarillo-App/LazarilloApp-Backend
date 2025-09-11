// utils/cryptoField.js
const crypto = require('crypto');

// misma key de 32 bytes
const KEY_STR = (process.env.ENCRYPTION_KEY || 'dev-key-dev-key-dev-key-32!!').slice(0, 32);
const KEY = Buffer.from(KEY_STR, 'utf8');

// ============ FORMATO NUEVO: AES-256-GCM (JSON -> base64) ============
function encryptSecret(plain = '') {
  const iv = crypto.randomBytes(12);
  const ciph = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([ciph.update(String(plain), 'utf8'), ciph.final()]);
  const tag = ciph.getAuthTag();
  const payload = {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function decryptSecret(b64 = '') {
  const txt = Buffer.from(b64, 'base64').toString('utf8');       // <-- espera JSON
  const payload = JSON.parse(txt);
  const iv  = Buffer.from(payload.iv,  'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const ct  = Buffer.from(payload.ct,  'base64');
  const dec = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
}

// ============ COMPAT: detectar formato viejo (AES-CTR en HEX) ============
const LEGACY_IV = Buffer.from('00000000000000000000000000000000'.slice(0, 32), 'hex'); // 16 bytes 0x00

function decryptSecretCompat(value = '') {
  if (!value) return '';

  // ¿Nuevo formato? (base64 que decodifica a JSON con {"v":...})
  try {
    const txt = Buffer.from(value, 'base64').toString('utf8');
    if (txt.startsWith('{"v":')) {
      return decryptSecret(value); // nuevo OK
    }
  } catch (_) {/* no es base64->JSON */}

  // ¿Viejo formato? (HEX puro, largo par)
  if (/^[0-9a-f]+$/i.test(value) && (value.length % 2 === 0)) {
    try {
      const dec = crypto.createDecipheriv('aes-256-ctr', Buffer.from(KEY_STR), LEGACY_IV);
      return Buffer.concat([dec.update(Buffer.from(value, 'hex')), dec.final()]).toString('utf8');
    } catch (_) { /* fallback abajo */ }
  }

  // Último intento: quizá sí era base64 válido pero JSON raro
  try { return decryptSecret(value); } catch (_) { return ''; }
}

module.exports = { encryptSecret, decryptSecret, decryptSecretCompat };
