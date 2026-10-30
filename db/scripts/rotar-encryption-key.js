// db/scripts/rotar-encryption-key.js
//
// Migra app_businesses.props.maxi.pass_enc (la ÚNICA cosa que usa
// ENCRYPTION_KEY en todo el código — confirmado: services/crypto.js,
// utils/cryptoField.js, maxiCredsService.js, businessController.js,
// syncController.js, maxiSalesService.js todos apuntan a este mismo campo)
// de la clave VIEJA a la clave NUEVA, re-encriptando cada valor.
//
// No depende de process.env.ENCRYPTION_KEY en ningún momento (las claves
// se pasan como argumento) — evita el problema de que utils/cryptoField.js
// cachea su KEY una sola vez al cargar el módulo, así que cambiar la env
// var a mitad de un script no le haría efecto.
//
// Soporta descifrar los 3 formatos que ya existen en la base (mismo orden
// que decryptSecretCompat/decryptText): nuevo "iv:tag:data" (crypto.js),
// blob base64 AES-GCM viejo, JSON base64 {v,iv,tag,ct} (cryptoField.js) y
// AES-CTR hex con IV=0 (legacy). Re-encripta siempre al formato nuevo
// "iv:tag:data" (el que usa maxiCredsService.saveCreds hoy).
//
// Uso:
//   node db/scripts/rotar-encryption-key.js --old=<hex64> --new=<hex64>              → dry-run
//   node db/scripts/rotar-encryption-key.js --old=<hex64> --new=<hex64> --aplicar    → aplica
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const pool = require('../../config/db');

function keyArg(nombre) {
  const arg = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  if (!arg) return null;
  const hex = arg.split('=')[1];
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
}

const APLICAR = process.argv.includes('--aplicar');
const OLD_KEY = keyArg('old');
const NEW_KEY = keyArg('new');

function decryptConKey(payload, key) {
  const s = String(payload || '').trim();
  if (!s) return null;

  // 1) Formato nuevo: "iv:tag:data" (base64, separado por ':') — crypto.js
  if (s.includes(':') && s.split(':').length === 3) {
    try {
      const [ivB64, tagB64, dataB64] = s.split(':');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
      d.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8');
    } catch { /* sigue probando */ }
  }

  // 2) Blob base64 viejo: iv(12) + tag(16) + data, todo junto — crypto.js legacy
  try {
    const raw = Buffer.from(s, 'base64');
    if (raw.length > 28) {
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const enc = raw.subarray(28);
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
    }
  } catch { /* sigue probando */ }

  // 3) JSON base64 {v,iv,tag,ct} — cryptoField.js
  try {
    const txt = Buffer.from(s, 'base64').toString('utf8');
    const payloadObj = JSON.parse(txt);
    const iv = Buffer.from(payloadObj.iv, 'base64');
    const tag = Buffer.from(payloadObj.tag, 'base64');
    const ct = Buffer.from(payloadObj.ct, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { /* sigue probando */ }

  // 4) AES-CTR hex con IV=0 — legacy más viejo
  if (/^[0-9a-f]{2,}$/i.test(s) && s.length % 2 === 0) {
    try {
      const d = crypto.createDecipheriv('aes-256-ctr', key, Buffer.alloc(16, 0));
      return Buffer.concat([d.update(Buffer.from(s, 'hex')), d.final()]).toString('utf8');
    } catch { /* nada más que probar */ }
  }

  return null;
}

function encryptConKey(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

async function main() {
  if (!OLD_KEY || !NEW_KEY) {
    console.log('Uso: node db/scripts/rotar-encryption-key.js --old=<hex64> --new=<hex64> [--aplicar]');
    process.exit(1);
  }
  console.log(APLICAR ? '── Aplicando cambios en la base ──' : '── DRY RUN: se calcula todo pero NO se guarda nada ──');

  const { rows } = await pool.query(
    `SELECT id, name, props->'maxi' AS maxi
       FROM app_businesses
      WHERE props->'maxi'->>'pass_enc' IS NOT NULL`
  );
  console.log(`Negocios con credenciales de Maxi guardadas: ${rows.length}`);

  let ok = 0, fallidos = 0;
  for (const biz of rows) {
    const passEncViejo = biz.maxi.pass_enc;
    const plano = decryptConKey(passEncViejo, OLD_KEY);
    if (plano == null) {
      console.log(`  ✗ negocio ${biz.id} "${biz.name}": no se pudo descifrar con la clave vieja`);
      fallidos++;
      continue;
    }
    const passEncNuevo = encryptConKey(plano, NEW_KEY);
    console.log(`  ✓ negocio ${biz.id} "${biz.name}": OK (${plano.length} caracteres)`);
    ok++;

    if (APLICAR) {
      await pool.query(
        `UPDATE app_businesses
            SET props = jsonb_set(props, '{maxi,pass_enc}', to_jsonb($2::text))
          WHERE id = $1`,
        [biz.id, passEncNuevo]
      );
    }
  }

  console.log(`\n──────────────────────────────`);
  console.log(`OK: ${ok}  ·  fallidos: ${fallidos}`);
  if (!APLICAR) console.log('\n(DRY RUN: nada de esto se guardó. Corré con --aplicar para aplicarlo.)');
  if (fallidos > 0) console.log('\n⚠️  Si hay fallidos, NO cambies ENCRYPTION_KEY en Render todavía — esos negocios perderían sus credenciales de Maxi.');

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
