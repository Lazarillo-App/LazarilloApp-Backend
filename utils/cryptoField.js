const crypto = require('crypto');
const KEY = Buffer.from((process.env.ENCRYPTION_KEY || '').padEnd(32,'0').slice(0,32), 'utf8'); // 32 bytes

function encryptSecret(plain='') {
  const iv   = crypto.randomBytes(12);
  const ciph = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct   = Buffer.concat([ciph.update(String(plain), 'utf8'), ciph.final()]);
  const tag  = ciph.getAuthTag();
  return Buffer.from(JSON.stringify({
    v:1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64')
  }), 'utf8').toString('base64');
}

function decryptSecret(b64='') {
  if (!b64) return '';
  const payload = JSON.parse(Buffer.from(b64,'base64').toString('utf8'));
  const iv  = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag,'base64');
  const ct  = Buffer.from(payload.ct, 'base64');
  const dec = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
